/*
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

/** node.js driver for Cassandra-CQL. */

var log = require('logmagic').local('node-cassandra-client.driver');
var logCql = require('logmagic').local('node-cassandra-client.driver.cql');
var logTiming = require('logmagic').local('node-cassandra-client.driver.timing');

var sys = require('sys');
var constants = require('constants');
var Buffer = require('buffer').Buffer;
var EventEmitter = require('events').EventEmitter;

var thrift = require('thrift');
var async = require('async');
var Cassandra = require('./gen-nodejs/Cassandra');
var ttypes = require('./gen-nodejs/cassandra_types');

var genericPool = require('generic-pool');

var Decoder = require('./decoder').Decoder;

// used to parse the CF name out of a select statement.
var selectRe = /\s*SELECT\s+.+\s+FROM\s+[\']?(\w+)/im;

var appExceptions = ['InvalidRequestException', 'TimedOutException', 'UnavailableException',
  'SchemaDisagreementException'];

var nullBindError = {
  message: 'null/undefined query parameter'
};

var DEFAULT_CONNECTION_TIMEOUT = 4000;

/** Default timeout for each of the steps (login, learn, use) which are performed 
* when the Connection to the Cassandra server has been established. */
var DEFAULT_STEP_TIMEOUTS = {
  'login': 1000,
  'learn': 2000,
  'use': 1000
};

/** converts object to a string using toString() method if it exists. */
function stringify(x) {
  if (x.toString) {
    return x.toString();
  } else {
    return x;
  }
}

/** wraps in quotes */
function quote(x) {
  return '\'' + x + '\'';
}

/** replaces single quotes with double quotes */
function fixQuotes(x) {
  return x.replace(/\'/img, '\'\'');
}

/**
 * binds arguments to a query. e.g: bind('select ?, ? from MyCf where key=?', ['arg0', 'arg1', 'arg2']);
 * quoting is handled for you.  so is converting the parameters to a string, preparatory to being sent up to cassandra.
 * @param query
 * @param args array of arguments. falsy values are never acceptable.
 * @return a buffer suitable for cassandra.execute_cql_query().
 */
function bind(query, args) {
  if (args.length === 0) {
    return query;
  }
  var q = 0;
  var a = 0;
  var str = '';
  while (q >= 0) {
    var oldq = q;
    q = query.indexOf('?', q);
    if (q >= 0) {
      str += query.substr(oldq, q-oldq);
      if (args[a] === null) {
        return nullBindError;
      }
      str += quote(fixQuotes(stringify(args[a++])));
      q += 1;
    } else {
      str += query.substr(oldq);
    }
  }
  return new Buffer(str);
}

/** returns true if obj is in the array */
function contains(a, obj) {
  var i = a.length;
  while (i > 0) {
    if (a[i-1] === obj) {
      return true;
    }
    i--;
  }
  return false;
}


System = module.exports.System = require('./system').System;
KsDef = module.exports.KsDef = require('./system').KsDef;
CfDef = module.exports.CfDef = require('./system').CfDef;
ColumnDef = module.exports.ColumnDef = require('./system').ColumnDef;
BigInteger = module.exports.BigInteger = require('./bigint').BigInteger;
UUID = module.exports.UUID = require('./uuid');


/**
 * Make sure that err.message is set to something that makes sense.
 *
 * @param {Object} err Error object.
 * @param {Object} connectionInfo Optional connection info object which is
 * attached to the error.
 */
function amendError(err, connectionInfo) {
  if (!err.message || err.message.length === 0) {
    if (err.name === "NotFoundException") {
      err.message = "ColumnFamily or Keyspace does not exist";
    } else if (err.why) {
      err.message = err.why;
    }
  }

  err.connectionInfo = connectionInfo;
  return err;
}

/** abstraction of a single row. */
Row = module.exports.Row = function(row, decoder) {
  // decoded key.
  this.key = decoder.decode(row.key, 'key');
  
  // cols, all names and values are decoded.
  this.cols = []; // list of hashes of {name, value};
  this.colHash = {}; // hash of  name->value
  
  var count = 0;
  for (var i = 0; i < row.columns.length; i++) {
    if (row.columns[i].value) {
      var decodedName = decoder.decode(row.columns[i].name, 'comparator');
      var decodedValue = decoder.decode(row.columns[i].value, 'validator', row.columns[i].name);
      this.cols[count] = {
        name: decodedName,
        value: decodedValue
      };
      this.colHash[decodedName] = decodedValue;
      count += 1;
    }
  }
  
  this._colCount = count;
};

/** @returns the number of columns in this row. */
Row.prototype.colCount = function() {
  return this._colCount;
};

/**
 * Perform queries against a pool of open connections.
 * 
 * Accepts a single argument of an object used to configure the new PooledConnection
 * instance.  The config object supports the following attributes:
 * 
 *         hosts : List of strings in host:port format.
 *      keyspace : Keyspace name.
 *          user : User for authentication (optional).
 *          pass : Password for authentication (optional).
 *       maxSize : Maximum number of connection to pool (optional).
 *    idleMillis : Idle connection timeout in milliseconds (optional).
 * 
 * Example:
 * 
 *   var pool = new PooledConnection({
 *     hosts      : ['host1:9160', 'host2:9170', 'host3', 'host4'],
 *     keyspace   : 'database',
 *     user       : 'mary',
 *     pass       : 'qwerty',
 *     maxSize    : 25,
 *     idleMillis : 30000
 *   });
 * 
 * @param config an object used to control the creation of new instances.
 */
PooledConnection = module.exports.PooledConnection = function(config) {
  config = config || {};
  this.nodes = [];
  this.holdFor = 10000;
  this.current_node = 0;
  this.use_bigints = config.use_bigints ? true : false;
  this.timeout = config.timeout || DEFAULT_CONNECTION_TIMEOUT;
  this.log_time = config.log_time || false;

  // Construct a list of nodes from hosts in <host>:<port> form
  for (var i = 0; i < config.hosts.length; i++) {
    var hostSpec = config.hosts[i];
    if (!hostSpec) { continue; }
    var host = hostSpec.split(':');
    if (host.length > 2) {
      log.warn('malformed host entry "' + hostSpec + '" (skipping)');
    }
    log.debug("adding " + hostSpec + " to working node list");
    this.nodes.push([host[0], (isNaN(host[1])) ? 9160 : host[1]]);
  }
  
  var self = this;
  var maxSize = isNaN(config.maxSize) ? 25 : config.maxsize;
  var idleMillis = isNaN(config.idleMillis) ? 30000 : config.idleMillis;
  
  this.pool = genericPool.Pool({
    name    : 'Connection',
    create  : function(callback) {
      // Advance through the set of configured nodes
      if ((self.current_node + 1) >= self.nodes.length) {
        self.current_node = 0;
      } else {
        self.current_node++;
      }
      
      var tries = self.nodes.length;
	    
	    function retry(curNode) {
	      tries--;
	      
	      if ((curNode + 1) >= self.nodes.length) {
          curNode = 0;
        } else {
          curNode++;
        }

	      var node = self.nodes[curNode];
	      // Skip over any nodes known to be bad
	      if (node.holdUntil > (new Date().getTime())) {
	        return retry(curNode);
	      }
	      
	      var conn = new Connection({host: node[0], 
                                   port: node[1], 
                                   keyspace: config.keyspace, 
                                   user: config.user, 
                                   pass: config.pass, 
                                   use_bigints: self.use_bigints,
                                   timeout: self.timeout,
                                   log_time: self.log_time});
	      
	      conn.connect(function(err) {
	        if (!err) {                   // Success, we're connected
	          callback(conn);
	        } else if (tries > 0) {       // Fail, mark node inactive and retry
	          log.err("Unabled to connect to " + node[0] + ":" + node[1] + " (skipping)");
	          node.holdUntil = new Date().getTime() + self.holdFor;
	          retry(curNode);
	        } else {                      // Exhausted all options
	          callback(err);
	        }
	      });
	    }
	    retry(self.current_node);
	  },
	  destroy : function(conn) { conn.close(); },
	  max     : maxSize,
	  idleTimeoutMillis : idleMillis,
	  log : false
  });
};

/**
 * executes any query
 * @param query any CQL statement with '?' placeholders.
 * @param args array of arguments that will be bound to the query.
 * @param callback executed when the query returns. the callback takes a different number of arguments depending on the
 * type of query:
 *    SELECT (single row): callback(err, row)
 *    SELECT (mult rows) : callback(err, rows)
 *    SELECT (count)     : callback(err, count)
 *    UPDATE             : callback(err)
 *    DELETE             : callback(err)
 */
PooledConnection.prototype.execute = function(query, args, callback) {
  var self = this;
  var seen = false;

  var exe = function(errback) {
    async.waterfall([
      function acquireConnFromPool(callback) {
        self.pool.acquire(function(err, conn) {
          callback(err, conn);
        });
      },

      function executeQuery(conn, callback) {
        conn.execute(query, args, function(err, res) {
          callback(err, res, conn);
        });
      }
    ],

    function(err, res, conn) {
      var connectionInfo;

      if (conn) {
        self.pool.release(conn);
      }

      if (err) {
        if (err.hasOwnProperty('name') && contains(appExceptions, err.name)) {
          callback(err, null);
        }
        else {
          if (!seen) {
            errback();
          }
          else {
            connectionInfo = (conn) ? conn.connectionInfo : null;
            err = amendError(err, connectionInfo);
            callback(err, res);
          }
        }
      }
      else {
        callback(err, res);
      }
    });
  };

  var retry = function() {
    seen = true;
    exe(retry);
  };

  exe(retry);
};

/**
 * Signal the pool to shutdown.  Once called, no new requests (read: execute())
 * can be made. When all pending requests have terminated, the callback is run.
 *
 * @param callback called when the pool is fully shutdown
 */
PooledConnection.prototype.shutdown = function(callback) {
  var self = this;
  this.pool.drain(function() {
    self.pool.destroyAllNow(callback);
  });
};

/**
 * @param options: valid parts are:
 *  user, pass, host, port, keyspace, use_bigints, timeout, log_time
 */
Connection = module.exports.Connection = function(options) {
  options = options || {};
  log.info('connecting ' + options.host + ':' + options.port);
  this.validators = {};
  this.con = thrift.createConnection(options.host, options.port);
  this.client = null;
  this.connectionInfo = options;
  this.timeout = options.timeout || DEFAULT_CONNECTION_TIMEOUT;
};


/**
 * makes the connection. 
 * @param callback called when connection is successful or ultimately fails (err will be present).
 */
Connection.prototype.connect = function(callback) {
  var self = this,
      timeoutId;

  this.con.on('error', function(err) {
    clearTimeout(timeoutId);
    amendError(err, self.connectionInfo);
    callback(err);
  });

  this.con.on('close', function() {
    clearTimeout(timeoutId);
    log.info(self.connectionInfo.host + ':' + self.connectionInfo.port + ' is closed');
  });

  this.con.on('connect', function() {
    clearTimeout(timeoutId);

    function decorateErrWithErrno(err, errno) {
      err.errno = errno;
      return err;
    }
    
    // preparing the conneciton is a 3-step process.
    
    // 1) login
    var login = function(cb) {
      if (self.connectionInfo.user || self.connectionInfo.pass) {
        var creds = new ttypes.AuthenticationRequest({user: self.connectionInfo.user, password: self.connectionInfo.pass});
        var timeoutId = setTimeout(function() {
          if (timeoutId) {
            timeoutId = null;
            cb(decorateErrWithErrno(new Error('login timed out'), constants.ETIMEDOUT));
          }
        }, DEFAULT_STEP_TIMEOUTS.login);
        self.client.login(creds, function(err) {
          if (timeoutId) {
            timeoutId = clearTimeout(timeoutId);
            if (err) { amendError(err, self.connectionInfo); }
            cb(err);
          }
        });
      } else {
        cb(null);
      }
    };
    
    // 2) login.
    var learn = function(cb) {
      var timeoutId = setTimeout(function() {
        if (timeoutId) {
          timeoutId = null;
          cb(decorateErrWithErrno(new Error('learn timed out'), constants.ETIMEDOUT));
        }
      }, DEFAULT_STEP_TIMEOUTS.learn);
      self.client.describe_keyspace(self.connectionInfo.keyspace, function(err, def) {
        if (timeoutId) {
          timeoutId = clearTimeout(timeoutId);
          if (err) {
            amendError(err, self.connectionInfo);
            cb(err);
          } else {
            for (var i = 0; i < def.cf_defs.length; i++) {
              var validators = {
                key: def.cf_defs[i].key_validation_class,
                comparator: def.cf_defs[i].comparator_type,
                defaultValidator: def.cf_defs[i].default_validation_class,
                specificValidators: {}
              };
              for (var j = 0; j < def.cf_defs[i].column_metadata.length; j++) {
                // todo: verify that the name we use as the key represents the raw-bytes version of the column name, not 
                // the stringified version.
                validators.specificValidators[def.cf_defs[i].column_metadata[j].name] = def.cf_defs[i].column_metadata[j].validation_class;
              }
              self.validators[def.cf_defs[i].name] = validators;
            }
            cb(null); // no errors.
          }
        }
      });
    };
    
    // 3) set the keyspace on the server.
    var use = function(cb) {
      var timeoutId = setTimeout(function() {
        timeoutId = null;
        cb(decorateErrWithErrno(new Error('use timed out'), constants.ETIMEDOUT));
      }, DEFAULT_STEP_TIMEOUTS.use);
      
      self.client.set_keyspace(self.connectionInfo.keyspace, function(err) {
        if (timeoutId) {
          timeoutId = clearTimeout(timeoutId);
          if (err) { amendError(err, self.connectionInfo); }
          cb(err);
        }
      });
    };

    async.series(
      [login, learn, use],
      function(err) {
        if (err) {
          self.close();
        }
        callback(err);
      }
    );
  });

  function connectTimeout() {
    var err = new Error('ETIMEDOUT, Operation timed out');
    err.errno = constants.ETIMEDOUT;

    try {
      self.con.connection.destroy(err);
    }
    catch (e) {}

    self.con = null;
  }

  // kicks off the connection process.
  this.client = thrift.createClient(Cassandra, this.con);

  // set a connection timeout handler
  timeoutId = setTimeout(connectTimeout, this.timeout);
};

Connection.prototype.close = function() {
  this.con.end();
  this.con = null;
  this.client = null;
};

/**
 * executes any query
 * @param query any cql statement with '?' placeholders.
 * @param args array of arguments that will be bound to the query.
 * @param callback executed when the query returns. the callback takes a different number of arguments depending on the
 * type of query:
 *    SELECT (single row): callback(err, row)
 *    SELECT (mult rows) : callback(err, rows)
 *    SELECT (count)     : callback(err, count)
 *    UPDATE             : callback(err)
 *    DELETE             : callback(err)
 */
Connection.prototype.execute = function(query, args, callback) {
  var cql = bind(query, args);
  if (cql === nullBindError) {
    callback(new Error(nullBindError.message));
  } else {
    var self = this,
        cqlString = cql.toString(),
        start, end, diff;

    start = new Date().getTime();
    logCql.trace('CQL QUERY', {'query': query, 'parameterized_query': cqlString, 'args': args});

    this.client.execute_cql_query(cql, ttypes.Compression.NONE, function(err, res) {
      end = new Date().getTime();
      diff = (end - start);
      if (self.connectionInfo.log_time) {
        logTiming.trace('CQL QUERY TIMING', {'query': query, 'parameterized_query': cqlString, 'args': args,
                                             'time': diff});
      }

      if (err) {
        amendError(err, self.connectionInfo);
        callback(err, null);
      } else if (!res) {
        callback(new Error('No results'), null);
      } else {
        if (res.type === ttypes.CqlResultType.ROWS) {
          var cfName = selectRe.exec(cql)[1];
          var decoder = new Decoder(self.validators[cfName], {use_bigints: self.connectionInfo.use_bigints});
          // for now, return results.
          var rows = [];
          for (var i = 0; i < res.rows.length; i++) {
            var row = new Row(res.rows[i], decoder);
            rows.push(row);
          }
          rows.rowCount = function() {
            return res.rows.length;
          };
          callback(null, rows);
        } else if (res.type === ttypes.CqlResultType.INT) {
          callback(null, res.num);
        } else if (res.type === ttypes.CqlResultType.VOID) {
          callback(null);
        }
      }
    }); 
  }
};

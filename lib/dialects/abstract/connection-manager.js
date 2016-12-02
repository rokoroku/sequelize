'use strict';

const Pooling = require('generic-pool');
const Promise = require('../../promise');
const _ = require('lodash');
const Utils = require('../../utils');
const debug = Utils.getLogger().debugContext('pool');
const semver = require('semver');
const defaultPoolingConfig = {
  max: 5,
  min: 0,
  idle: 10000,
  handleDisconnects: true
};

class ConnectionManager {

  constructor(dialect, sequelize) {
    const config = _.cloneDeep(sequelize.config);

    this.sequelize = sequelize;
    this.config = config;
    this.dialect = dialect;
    this.versionPromise = null;
    this.dialectName = this.sequelize.options.dialect;

    if (config.pool !== false) {
      config.pool =_.defaults(config.pool || {}, defaultPoolingConfig, {
        validate: this._validate.bind(this)
      }) ;
    } else {
      throw new Error('Support for pool:false was removed in v4.0');
    }

    // Save a reference to the bound version so we can remove it with removeListener
    this.onProcessExit = this.onProcessExit.bind(this);

    process.on('exit', this.onProcessExit);
  }

  refreshTypeParser(dataTypes) {
    _.each(dataTypes, (dataType) => {
      if (dataType.hasOwnProperty('parse')) {
        if (dataType.types[this.dialectName]) {
          this._refreshTypeParser(dataType);
        } else {
          throw new Error('Parse function not supported for type ' + dataType.key + ' in dialect ' + this.dialectName);
        }
      }
    });
  }

  onProcessExit() {
    if (this.pool) {
      this.pool.drain(() => {
        debug('connection drain due to process exit');
        this.pool.destroyAllNow();
      });
    }
  }

  close() {
    this.onProcessExit();
    process.removeListener('exit', this.onProcessExit); // Remove the listener, so all references to this instance can be garbage collected.

    this.getConnection = function getConnection() {
      return Promise.reject(new Error('ConnectionManager.getConnection was called after the connection manager was closed!'));
    };
  }

  // This cannot happen in the constructor because the user can specify a min. number of connections to have in the pool
  // If he does this, generic-pool will try to call connect before the dialect-specific connection manager has been correctly set up
  initPools() {
    const config = this.config;

    if (!config.replication) {
      this.pool = Pooling.createPool({
        create: () => {
          return this._connect(config).tap(() => {
            debug(`pool created max/min: ${config.pool.max}/${config.pool.min} with no replication`);
          });
        },
        destroy: (connection) => {
          return this._disconnect(connection).tap(() => {
            debug('connection destroy');
          });
        },
        validate: config.pool.validate
      }, {
        Promise,
        max: config.pool.max,
        min: config.pool.min,
        idleTimeoutMillis: config.pool.idle
      });
      return;
    }

    let reads = 0;

    if (!Array.isArray(config.replication.read)) {
      config.replication.read = [config.replication.read];
    }

    // Map main connection config
    config.replication.write = _.defaults(config.replication.write, _.omit(config, 'replication'));

    // Apply defaults to each read config
    config.replication.read = _.map(config.replication.read, readConfig =>
      _.defaults(readConfig, _.omit(this.config, 'replication'))
    );

    // custom pooling for replication (original author @janmeier)
    this.pool = {
      release: client => {
        if (client.queryType === 'read') {
          return this.pool.read.release(client);
        } else {
          return this.pool.write.release(client);
        }
      },
      acquire: (priority, queryType, useMaster) => {
        useMaster = _.isUndefined(useMaster) ? false : useMaster;
        if (queryType === 'SELECT' && !useMaster) {
          return this.pool.read.acquire(priority);
        } else {
          return this.pool.write.acquire(priority);
        }
      },
      destroy: connection => {
        debug('connection destroy');
        return this.pool[connection.queryType].destroy(connection);
      },
      destroyAllNow: () => {
        debug('all connection destroy');
        this.pool.read.destroyAllNow();
        this.pool.write.destroyAllNow();
      },
      drain: () => {
        return this.pool.write.drain(() => {
          return this.pool.read.drain();
        });
      },
      read: Pooling.createPool({
        create: () => {
          const nextRead = reads++ % config.replication.read.length; // round robin config
          return this._connect(config.replication.read[nextRead]).then(connection => {
            connection.queryType = 'read';
            return connection;
          });
        },
        destroy: connection => {
          return this._disconnect(connection);
        },
        validate: config.pool.validate
      }, {
        Promise,
        max: config.pool.max,
        min: config.pool.min,
        idleTimeoutMillis: config.pool.idle
      }),
      write: Pooling.createPool({
        create: () => {
          return this._connect(config.replication.write).tap(connection => {
            connection.queryType = 'write';
            return connection;
          });
        },
        destroy: connection => {
          return this._disconnect(connection);
        },
        validate: config.pool.validate
      }, {
        Promise,
        max: config.pool.max,
        min: config.pool.min,
        idleTimeoutMillis: config.pool.idle
      })
    };
  }

  getConnection(options) {
    options = options || {};

    let promise;
    if (this.sequelize.options.databaseVersion === 0) {
      if (this.versionPromise) {
        promise = this.versionPromise;
      } else {
        promise = this.versionPromise = this._connect(this.config.replication.write || this.config).then(connection => {
          const _options = {};
          _options.transaction = {connection}; // Cheat .query to use our private connection
          _options.logging = () => {};
          _options.logging.__testLoggingFn = true;

          return this.sequelize.databaseVersion(_options).then(version => {
            this.sequelize.options.databaseVersion = semver.valid(version) ? version : this.defaultVersion;
            this.versionPromise = null;

            return this._disconnect(connection);
          });
        }).catch(err => {
          this.versionPromise = null;
          throw err;
        });
      }
    } else {
      promise = Promise.resolve();
    }

    return promise.then(() => {
      return this.pool.acquire(options.priority, options.type, options.useMaster);
    });
  }

  releaseConnection(connection) {
    return this.pool.release(connection).tap(() => {
      debug('connection released');
    });
  }

  _connect(config) {
    return this.sequelize.runHooks('beforeConnect', config)
      .then(() => this.dialect.connectionManager.connect(config));
  }

  _disconnect(connection) {
    return this.dialect.connectionManager.disconnect(connection);
  }

  _validate(connection) {
    if (!this.dialect.connectionManager.validate)
      return Promise.resolve(true);
    return this.dialect.connectionManager.validate(connection);
  }
}

module.exports = ConnectionManager;
module.exports.ConnectionManager = ConnectionManager;
module.exports.default = ConnectionManager;

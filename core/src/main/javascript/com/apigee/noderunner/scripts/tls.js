// This is a version of the interface for the "tls" module that works in the Noderunner environment.
// Why? Because the native node TLS module is a hand-written, in JavaScript, implementation of SSL on top
// of OpenSSL. The SSL functionality available in Java (SSLEngine) is very different, and mapping the two
// is going to be ugly. So, this module uses standard "net" to handle the ciphertext connection, and an internal
// Java module that wraps SSLEngine for the SSL bit.
// This also allows us to use standard Java mechanisms to replace SSLEngine with alternatives in highly
// secure environments.

var assert = require('assert');
var util = require('util');
var net = require('net');
var Stream = require('stream');
var nodetls = require('node_tls');
var StringDecoder = require('string_decoder').StringDecoder;
var wrap = process.binding('ssl_wrap');
var EventEmitter = require('events').EventEmitter;
var tlscheckidentity = require('tls_checkidentity');

var debug;
if (process.env.NODE_DEBUG && /tls/.test(process.env.NODE_DEBUG)) {
  debug = function(x) { console.error('TLS:', x); };
} else {
  debug = function() { };
}

function Server() {
  var options, listener;

  if (typeof arguments[0] == 'function') {
    options = {};
    listener = arguments[0];
  } else {
    options = arguments[0] || {};
    listener = arguments[1];
  }
  if (!(this instanceof Server)) return new Server(options, listener);

  var self = this;
  if ((options == undefined) || (options.keystore == undefined)) {
    throw 'keystore in Java JKS format must be included in options';
  }
  if (listener) {
    self.on('secureConnection', listener);
  }

  self.context = wrap.createContext();
  self.context.setKeyStore(options.keystore, options.passphrase);
  if (options.truststore) {
    self.context.setTrustStore(options.truststore);
  }
  self.context.init();

  if (options.ciphers) {
    var tmpEngine = self.context.createEngine(false);
    if (!tmpEngine.validateCiphers(options.ciphers)) {
      throw 'Invalid cipher list: ' + options.ciphers;
    }
  }


  self.netServer = net.createServer(options, function(connection) {
    var engine = self.context.createEngine(false);
    if (options.ciphers) {
      engine.setCiphers(options.ciphers);
    }
    var clearStream = new CleartextStream();
    clearStream.init(true, self, connection, engine);
  });
  return self;
}
util.inherits(Server, net.Server);
exports.Server = Server;

exports.createServer = function () {
  return new Server(arguments[0], arguments[1]);
};

Server.prototype.listen = function() {
  var callback;
  var options;
  var self = this;
  if (typeof arguments[0] == 'function') {
    callback = arguments[0];
  } else if (typeof arguments[1] == 'function') {
    callback = arguments[1];
  } else if (typeof arguments[2] == 'function') {
    callback = arguments[2];
  }

  if (callback !== undefined) {
    self.on('listening', callback);
  }
  this.netServer.on('listening', function() {
    debug('listening');
    self.emit('listening');
  });
  self.netServer.listen(arguments[0], arguments[1], arguments[2]);
};

exports.connect = function() {
  var args = net._normalizeConnectArgs(arguments);
  var options = args[0];
  var callback = args[1];

  if (options.host === undefined) {
    options.host = 'localhost';
  }

  var sslContext;
  if (options.rejectUnauthorized == false) {
    sslContext = wrap.createContext();
    sslContext.setTrustEverybody();
    sslContext.init();
  } else if (options.truststore) {
    sslContext = wrap.createContext();
    sslContext.setTrustStore(options.truststore);
    sslContext.init();
  } else {
    sslContext = wrap.createDefaultContext();
  }

  // TODO pass host and port to SSL engine init
  var engine = sslContext.createEngine(true);
  var sslConn = new CleartextStream();
  var netConn;
  if (options.socket) {
    netConn = options.socket;
  } else {
    netConn = net.connect(options, function() {
      sslConn.engine.beginHandshake();
      writeCleartext(sslConn);
    });
  }
  sslConn.init(false, undefined, netConn, engine);
  if (callback) {
    sslConn.on('secureConnect', callback);
  }
  if (options.socket) {
    sslConn.engine.beginHandshake();
    writeCleartext(sslConn);
  }
  return sslConn;
};

exports.createSecurePair = function() {
  throw 'Not implemented';
};

exports.checkServerIdentity = tlscheckidentity.checkServerIdentity;

Server.prototype.close = function() {
  debug('Server.close');
  this.netServer.close();
  this.emit('close');
};

Server.prototype.addContext = function(hostname, credentials) {
  // TODO something...
};

var counter = 0;

function CleartextStream() {
  this.id = ++counter;
}
util.inherits(CleartextStream, net.Socket);

CleartextStream.prototype.init = function(serverMode, server, connection, engine) {
  var self = this;
  self.serverMode = serverMode;
  self.server = server;
  self.connection = connection;
  self.engine = engine;
  self.closed = false;
  self.closing = false;
  self.remoteAddress = connection.remoteAddress;
  self.remotePort = connection.remotePort;
  connection.ondata = function(data, offset, end) {
    debug(self.id + ' onData');
    readCiphertext(self, data, offset, end);
  };
  connection.onend = function() {
    debug(self.id + ' onEnd');
    handleEnd(self);
  };
  connection.on('error', function(err) {
    debug(self.id + ' onError');
    self.emit('error', err);
  });
  connection.on('close', function() {
    debug(self.id + ' onClose');
    if (!self.closed) {
      doClose(self);
    }
  });
  connection.on('timeout', function() {
    debug(self.id + ' onTimeout');
    self.emit('timeout');
  });
  connection.on('drain', function() {
    debug(self.id + ' onDrain');
    self.emit('drain');
  });
};

function doClose(self) {
  self.closed = true;
  self.connection.destroy();
  self.emit('close', false);
}

CleartextStream.prototype.getPeerCertificate = function() {
  // TODO
};

CleartextStream.prototype.getCipher = function() {
  // TODO
};

CleartextStream.prototype.address = function() {
  return this.connection.address();
};

CleartextStream.prototype.pause = function() {
  this.connection.pause();
}

CleartextStream.prototype.resume = function() {
  this.connection.resume();
}

CleartextStream.prototype.write = function(data, arg1, arg2) {
  debug(this.id + ' write');
  var encoding, cb;

  // parse arguments
  if (arg1) {
    if (typeof arg1 === 'string') {
      encoding = arg1;
      cb = arg2;
    } else if (typeof arg1 === 'function') {
      cb = arg1;
    } else {
      throw new Error('bad arg');
    }
  }

  if (typeof data === 'string') {
    encoding = (encoding || 'utf8').toLowerCase();
    data = new Buffer(data, encoding);
  } else if (!Buffer.isBuffer(data)) {
    throw new TypeError('First argument must be a buffer or a string.');
  }

  return writeCleartext(this, data, cb);
};

CleartextStream.prototype.end = function(data, encoding) {
  debug(this.id + ' end');
  if (data) {
    this.write(data, encoding);
  }
  if (!this.closed && !this.ended) {
    debug(this.id + ' Closing SSL outbound');
    this.ended = true;
    this.engine.closeOutbound();
    while (!this.engine.isOutboundDone()) {
      writeCleartext(this);
    }
  }
};

// Got an end from the network
function handleEnd(self) {
  if (!self.closed) {
    if (self.ended) {
      doClose(self);
    } else {
      debug(self.id + ' Closing SSL inbound');
      self.ended = true;
      self.engine.closeInbound();
      while (!self.engine.isInboundDone()) {
        writeCleartext(self);
      }
      self.emit('end');
    }
  }
}

CleartextStream.prototype.destroy = function() {
  this.connection.destroy();
}

CleartextStream.prototype.justHandshaked = function() {
  debug(this.id + ' justHandshaked');
  this.readable = this.writable = true;
  if (this.serverMode) {
    this.server.emit('secureConnection', this);
  } else {
    this.emit('secureConnect');
  }
}

CleartextStream.prototype.setEncoding = function(encoding) {
  this.decoder = new StringDecoder(encoding);
}

CleartextStream.prototype.address = function() {
  return this.connection.address();
}

CleartextStream.prototype.getCipher = function() {
  return this.engine.getCipher();
}

// TODO offset and end
function readCiphertext(self, data) {
  var sslResult = self.engine.unwrap(data);
  debug(self.id + ' readCiphertext(' + (data ? data.length : 0) + '): SSL status ' + sslResult.status +
        ' read ' + sslResult.consumed + ' produced ' + (sslResult.data ? sslResult.data.length : 0));
  if (sslResult.justHandshaked) {
    self.justHandshaked();
  }

  switch (sslResult.status) {
    case self.engine.NEED_WRAP:
      writeCleartext(self);
      break;
    case self.engine.NEED_UNWRAP:
      // Sometimes we need to unwrap while we're unwrapping I guess
      readCiphertext(self);
      break;
    case self.engine.NEED_TASK:
      self.engine.runTask(function() {
        readCiphertext(self);
      });
      break;
    case self.engine.UNDERFLOW:
      // Nothing to do -- wait until we get more data
      break;
    case self.engine.OK:
      if (sslResult.data) {
        emitRawData(self, sslResult.data);
      }
      if (sslResult.remaining > 0) {
        // Once handshaking is done, we might need to unwrap again with the same data
        readCiphertext(self);
      }
      break;
    case self.engine.CLOSED:
      if (!self.closed) {
        if (self.ended) {
          doClose(self);
        } else {
          self.ended = true;
          self.emit('end');
        }
      }
      break;
    case self.engine.ERROR:
      debug('SSL error -- closing');
      doClose(self);
      break;
    default:
      throw 'Unexpected SSL engine status ' + sslResult.status;
  }
}

function writeCleartext(self, data, cb) {
  var sslResult = self.engine.wrap(data);
  var writeStatus = false;
  debug(self.id + ' writeCleartext(' + (data ? data.length : 0) + '): SSL status ' + sslResult.status +
        ' length ' + (sslResult.data ? sslResult.data.length : 0));
  if (cb) {
    if (!self.writeCallbacks) {
      self.writeCallbacks = [];
    }
    self.writeCallbacks.push(cb);
  }
  if (sslResult.data) {
    debug(self.id + ' Writing ' + sslResult.data.length);
    writeStatus = self.connection.write(sslResult.data, function() {
      if (self.writeCallbacks) {
        var popped = self.writeCallbacks.pop();
        while (popped) {
          popped();
          popped = self.writeCallbacks.pop();
        }
      }
    });
  }
  if (sslResult.justHandshaked) {
    self.justHandshaked();
  }

  switch (sslResult.status) {
    case self.engine.NEED_WRAP:
      writeCleartext(self);
      break;
    case self.engine.NEED_UNWRAP:
      readCiphertext(self);
      break;
    case self.engine.NEED_TASK:
      self.engine.runTask(function() {
        writeCiphertext(self);
      });
      break;
    case self.engine.UNDERFLOW:
    case self.engine.OK:
      break;
    case self.engine.CLOSED:
      if (!self.closed) {
        if (self.ended) {
          doClose(self);
        } else {
          self.ended = true;
          self.emit('end');
        }
      }
      break;
    case self.engine.ERROR:
      debug('SSL error -- closing');
      doClose(self);
      break;
    default:
      throw 'Unexpected SSL engine status ' + sslResult.status;
  }
  return writeStatus;
}

function emitRawData(self, data) {
  debug(self.id + ' emitBuffer: ' + data.length);
  if (self.decoder) {
    var decoded = self.decoder.write(data);
    if (decoded) {
      debug(self.id + ' emitBuffer: decoded string ' + decoded.length);
      emitBuffer(self, decoded);
    }
  } else {
    emitBuffer(self, data);
  }
}

function emitBuffer(self, buf) {
  self.emit('data', buf);
  if (self.ondata) {
    self.ondata(buf, 0, buf.length);
  }
}

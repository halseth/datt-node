var Workers = require('./workers')
var workers = false
var asyncCrypto

/**
 * AsyncCrypto is a module for doing cryptography with an asynchronous
 * interface with web workers (browser) or child process forks (node). It uses
 * the workerpool module to automatically manage the workers with an interface
 * isomorphic between node and a browser (i.e., it works in both).
 *
 * TODO: This module may actually not be necessary. We could use "Workers"
 * directly. Or move the functionality of Workers into here.
 */
function AsyncCrypto (_workers) {
  if (!(this instanceof AsyncCrypto)) {
    return new AsyncCrypto(_workers)
  }
  if (!_workers) {
    if (!workers) {
      // Cache global workers, so if you create a new asyncCrypto instance it
      // will use the global workers by default.
      workers = Workers()
    }
    this.workers = workers
  } else {
    // If you want to set your own workers, you can do so by specifying them in
    // the constructor.
    this.workers = _workers
  }
}

AsyncCrypto.prototype.sha256 = function sha256 (databuf) {
  return this.workers.sha256(databuf)
}

AsyncCrypto.prototype.publicKeyFromPrivateKey = function (privateKey) {
  return this.workers.publicKeyFromPrivateKey(privateKey)
}

AsyncCrypto.prototype.addressFromPublicKey = function (publicKey) {
  return this.workers.addressFromPublicKey(publicKey)
}

/**
 * From a given random seed of 128 bits, use BIP 39 to derive the mnemonic,
 * xprv, and xpub.
 */
AsyncCrypto.prototype.xkeysFromSeed = function (seedbuf) {
  return this.workers.xkeysFromSeed(seedbuf)
}

/**
 * From a given xprv and path, use BIP 32 to derive a new xprv, xpub and
 * address.
 */
AsyncCrypto.prototype.deriveXkeysFromXprv = function (xprv, path) {
  return this.workers.deriveXkeysFromXprv(xprv, path)
}

AsyncCrypto.prototype.sign = function (hash, privateKey, endian) {
  return this.workers.sign(hash, privateKey, endian)
}

AsyncCrypto.prototype.verifySignature = function verifySignature (hash, signature, publicKey) {
  return this.workers.verifySignature(hash, signature, publicKey)
}

asyncCrypto = new AsyncCrypto()
for (var method in AsyncCrypto.prototype) {
  // This javascript wizardry makes it possible to use methods like
  // AsyncCrypto.sha256 that will re-use the same global asyncCrypto object for
  // convenience
  AsyncCrypto[method] = AsyncCrypto.prototype[method].bind(asyncCrypto)
}

module.exports = AsyncCrypto

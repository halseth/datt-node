var User = require('./user')
var Peer = require('./peer')
var Message = require('./message')
var ContentStore = require('./contentStore')
var Content = require('./content')
var ContentDiscovery = require('./contentDiscovery')
var events = require('events')
var u = require('underscore')
var q = require('q')
var logger = require('./logger')

/**
 * Initiate the configuration for "Datt", which is basically the main loop of
 * the application. This module handles establishing connections, and
 * processing received messages, and also provides an interface for a user of
 * the application to broadcast messages.
 *
 * TODO: I believe this module should be refactored into some distinct
 * components. One component should be the "Connection Manager" which manages
 * the connections, handles disconnects, reconnects, and connecting to new
 * peers, and providing an interface for connecting to hand-entered peers.
 * Another module is the "Message Handler" which responds to distinct message
 * types by accessing the database and responding to messages in the
 * appropriate way. And then the "Main" module, which initializes both of those
 * interfaces and connects them together.
 *
 * There might be other ways to refactor, but either way, we should distinguish
 * between the different pieces of "managing connections" and "responding to
 * messages".
 */
function Datt (coordinationServerConfig) {
  var config = u.extend({
    debug: 3,
    host: 'localhost', /** default to localhost **/
    port: 3000,
    path: '/'
  }, coordinationServerConfig)

  this.config = coordinationServerConfig
  this.peer = new Peer(config)
  this.peers = null
  this.user = null
  this.contentDiscovery = new ContentDiscovery()
  this.contentListener = new events.EventEmitter()
}

/**
 * Initialize Datt, which sets up a listener for when we are connected to the
 * rendezvous server, and then requests a list of all peers, which we then
 * connect to. Also sets up a listener for what to do when we have a new
 * connection.
 */
Datt.prototype.init = function init () {
  var deferred_peers = q.defer()
  var p_peers = deferred_peers.promise

  this.peer.on('error', function () {
    deferred_peers.reject(new Error('Could not listen for connections'))
  })

  this.peer.on('open', function () {
    logger.debug('PeerJS connected!')
    if (this.config && this.config.onOpen && typeof (this.config.onOpen) === 'function') {
      try {
        this.config.onOpen()
      } catch (exc) {}
    }
    // TODO: There should proably be a "main event loop" somewhere that handles
    // the logic of finding and connecting to peers. Whatever that function is
    // should also probably be an EventEmitter that creates events and listens
    // for posted data and whatnot.
    this.getPeers()
    deferred_peers.resolve()
  }.bind(this))

  this.getPeers = function refreshPeers () {
    this.peer.listAllPeers(function (peers) {
      logger.debug('Datt got peers!')

      this.peers = peers
      if (this.config && this.config.onPeers && typeof (this.config.onPeers) === 'function') {
        try {
          this.config.onPeers(peers)
        } catch(exc) {}
      }
      if (!this.peer.connections.length) {
        this._connectToAvailablePeers()
      }
    }.bind(this))
  }.bind(this)

  this.peer.on('connection', function (dataConnection) {
    var peerId = (dataConnection && dataConnection.peer ? dataConnection.peer : null)
    logger.debug("New connection from '" + peerId + "'")
    this._setupNewConnection(dataConnection)
  }.bind(this))

  this.contentStore = new ContentStore('datt-store')
  var p_contentStore = this.contentStore.init()

  return q.all([p_contentStore, p_peers])
}

/**
 * This function is executed both when we choose to connect to another peer, or
 * when another peer tries to connect to us. It sets up listeners for what to
 * do when data is received.
 */
Datt.prototype._setupNewConnection = function _setupNewConnection (dataConnection) {
  var peerId = (dataConnection && dataConnection.peer ? dataConnection.peer : null)
  try {
    logger.debug(JSON.stringify(dataConnection, null, 4))
  } catch(exc) {}
  logger.debug('')
  if (this.config && this.config.onConnection && typeof (this.config.onConnection) === 'function') {
    try {
      this.config.onConnection(dataConnection)
    } catch(exc) {}
  }

  dataConnection.on('data', function (data) {
    logger.debug("Connection w/ '" + peerId + "' sent data:")
    try {
      logger.debug(data)
      var message = Message.fromObject(JSON.parse(data))
      this.handleReceivedMessage(message)
    } catch (exc) {}

    if (this.config && this.config.onConnectionData && typeof (this.config.onConnectionData) === 'function') {
      try {
        this.config.onConnectionData(data, dataConnection)
      } catch(exc) {}
    }
  }.bind(this))

  if (this.peers.indexOf(peerId) === -1) {
    this.peers.push(peerId)
  }
  this.connections = this.connections || {}
  this.connections[peerId] = dataConnection
}

/**
 * Authenticate with a username and password. This function is asynchronous
 * because authenticating involves cryptography, which should be run in a
 * separate process (node) or web worker (browser). That is not yet actually
 * implemented.
*/
Datt.prototype.signIn = function signIn (username, password) {
  this.user = new User(username, password)
  return this.user.init().then(function () {
    if (this.user) {
      this.announceIdentity()
    }
    return this.user
  }.bind(this))
}

/**
 * Add content to the database.
 */
Datt.prototype.addContent = q.promised(function addContent (content) {
  if (typeof (content) === 'string') {
    if (!this.user) {
      throw new Error('Datt#addContent: user must be signed in to create new content!')
    }
    content = new Content(content, this.user.getUsername(), this.user.getAddress(), null, null, this.user.getPubKey(), this.user.sign(content))
  }

  return content.init()
    .then(function (content) {
      return this.contentStore.putContent(content)
    }.bind(this))
})

/**
 * TODO: Is this method intended to do something different than addContent?
 */
Datt.prototype.pushContent = function pushContent (content) {}

/**
 * Some content will be stored locally, but more likely, most content will be
 * stored somewhere else on the netwotk. This method will first try to find the
 * content locally, then on the network if it is not found locally.
 */
Datt.prototype.getContent = function getContent (hash) {
  var deferred = q.defer()

  this.getLocalContent(hash).then(function (localContent) {
    deferred.resolve(localContent)
  }).fail(function () {
    this.contentListener.once('Received:' + hash, function (remoteContent) {
      logger.debug('Received the remote content!')
      deferred.resolve(remoteContent)
    }.bind(this))
    this.getRemoteContent(hash)
  }.bind(this))

  return deferred.promise
}

/**
 * Get content from the database (i.e., locally).
 */
Datt.prototype.getLocalContent = function getLocalContent (hash) {
  return this.contentStore.getContent(hash)
}

/**
 * Get content from the network.
 */
Datt.prototype.getRemoteContent = function getRemoteContent (hash) {
  return this.findPeersForContent(hash)
}

/**
 * Broadcast a message to our peers with a hash asking if they have a piece of
 * content.
 */
Datt.prototype.askPeersForContent = function askPeersForContent (hash) {
  if (hash) {
    this.broadcastMessage(Message.contentRequestByHash(hash))
  }
}

/**
 * TODO: This appears to override the above function.
 */
Datt.prototype.askPeersForContent = function askPeersForContentByUser (user) {}

/**
 * Broadcast a message telling all of our peers what user we are.
 */
Datt.prototype.announceIdentity = function announceIdentity () {
  if (!this.user) {
    throw new Error('Need to be signed in to announce identity!')
  } else {
    this.broadcastMessage(this.user.serialize())
  }
}

/**
 * When we receive a message, we need to process each recevied message in a
 * different way. For instance, if a peer is asking for data, our response
 * should be first to check to see if we have that data, and if so, then to
 * respond with that data. If a peer is asking for whate peers we are connected
 * to, we should respond with a list of those peers.
 */
Datt.prototype.handleReceivedMessage = function handleReceivedMessage (message) {
  var hash
  logger.debug('Got message: ' + message.serialize())
  switch (message.type) {
    case Message.Type.REQUEST_PEERS_FOR_HASH:
      logger.debug('Got peer request')
      this.contentDiscovery.handleContentDiscoveryRequest(message, this)
      break
    case Message.Type.ANNOUNCE_PEERS_FOR_HASH:
      hash = message.body.hash
      var peers = message.body.peers
      logger.debug('Got peers for hash ' + hash + ': ' + peers)
      this.contentDiscovery.handleAnnouncePeersForHash(message, this)
      break
    case Message.Type.REQUEST_CONTENT_BY_HASH:
      hash = message.body.hash
      var sender = message.body.sender
      logger.debug('peer ' + sender + ' is requesting content ' + hash)
      this.getContent(hash).then(function (content) {
        logger.debug('Sending content to ' + sender)
        this.sendMessage(Message.content(hash, content).serialize(), sender)
      }.bind(this)).fail(function (err) {
        logger.debug('Did not have content? ' + err)
      })
      break
    case Message.Type.CONTENT:
      hash = message.body.hash
      Content.fromObject(message.body.content).then(function (content) {
        logger.debug('Received content: ' + content.serialize())
        logger.debug('Adding content to local storage')
        this.addContent(content)
        this.contentListener.emit('Received:' + hash, content)
      }.bind(this))
      break
    default:
      logger.debug('Unknown message type')
  }
}

/**
 * Find peers that have a particular piece of content
 */
Datt.prototype.findPeersForContent = function findPeersForContent (hash) {
  this.contentDiscovery.findPeersForContent(hash, this)
}

/**
 * This method is called when we connect to a rendezvous server and receive a
 * list of candidate peers. We take that list and try to connect to every one
 * of the available peers.
 */
Datt.prototype._connectToAvailablePeers = function _refreshConnections () {
  this.connections = this.connections || {}
  for (var peerKey in this.peers) {
    var peer = this.peers[peerKey]
    if (peer === this.peer.id) {
      continue
    }
    var dataConnection = this.peer.connect(peer)
    logger.debug("Connecting to peer '" + peer + "'")
    this._setupNewConnection(dataConnection)
  }
}

/**
 * Send a message to all peers. Returns a promise that resolves when all
 * messages are sent. Rejects if there is an error sending to at least one
 * peer.
 */
Datt.prototype.broadcastMessage = function broadcastMessage (message) {
  var p = []
  for (var peerConnectionKey in this.connections) {
    var peerConnection = this.connections[peerConnectionKey]
    p.push(q.nbind(peerConnection.send, peerConnection)(message))
  }
  return q.all(p)
}

/**
 * Send a message to a particular peer (as contrasted with broadcasting a
 * messsage, which sends the same message to every peer).
 */
Datt.prototype.sendMessage = function sendMessage (message, receiverId) {
  logger.debug('Sending message ' + message + ' to ' + receiverId)

  var p = []
  var peerConnection = this.connections[receiverId]
  p.push(q.nbind(peerConnection.send, peerConnection)(message))
  return q.all(p)
}

module.exports = Datt

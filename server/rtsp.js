(function() {
  var Bits, CRLF_CRLF, DAY_NAMES, DEBUG_DISABLE_UDP_TRANSPORT, DEBUG_HTTP_TUNNEL, DEBUG_OUTGOING_PACKET_DATA, DEBUG_OUTGOING_RTCP, DEBUG_RTSP, DEBUG_RTSP_HEADERS_ONLY, DEFAULT_SERVER_NAME, ENABLE_START_PLAYING_FROM_KEYFRAME, MONTH_NAMES, RTSPClient, RTSPServer, SINGLE_NAL_UNIT_MAX_SIZE, Sequent, TAG, TIMESTAMP_ROUNDOFF, aac, api, avstreams, config, crypto, dgram, enabledFeatures, generateNewSessionID, generateRandom32, h264, http, logger, net, os, pad, resetStreamParams, rtp, sdp, url, zeropad,
    slice = [].slice;

  net = require('net');

  dgram = require('dgram');

  os = require('os');

  crypto = require('crypto');

  url = require('url');

  Sequent = require('sequent');

  rtp = require('./rtp');

  sdp = require('./sdp');

  h264 = require('./h264');

  aac = require('./aac');

  http = require('./http');

  avstreams = require('./avstreams');

  Bits = require('./bits');

  logger = require('./logger');

  config = require('./config');

  enabledFeatures = [];

  if (config.enableRTSP) {
    enabledFeatures.push('rtsp');
  }

  if (config.enableHTTP) {
    enabledFeatures.push('http');
  }

  TAG = enabledFeatures.join('/');

  DEFAULT_SERVER_NAME = 'node-rtsp-server';

  ENABLE_START_PLAYING_FROM_KEYFRAME = false;

  SINGLE_NAL_UNIT_MAX_SIZE = 1358;

  DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  DEBUG_RTSP = false;

  DEBUG_RTSP_HEADERS_ONLY = false;

  DEBUG_OUTGOING_PACKET_DATA = false;

  DEBUG_OUTGOING_RTCP = false;

  DEBUG_HTTP_TUNNEL = false;

  DEBUG_DISABLE_UDP_TRANSPORT = false;

  CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a];

  TIMESTAMP_ROUNDOFF = 4294967296;

  if (DEBUG_OUTGOING_PACKET_DATA) {
    logger.enableTag('rtsp:out');
  }

  //Used for padding a number to make it
  //have columns digits
  zeropad = function(columns, num) {
    num += '';
    while (num.length < columns) {
      num = '0' + num;
    }
    return num;
  };

  pad = function(digits, n) {
    n = n + '';
    while (n.length < digits) {
      n = '0' + n;
    }
    return n;
  };

  //Generates a new session ID to be passed to
  //the client.
  generateNewSessionID = function(callback) {
    var i, id, j;
    id = '';
    for (i = j = 0; j <= 7; i = ++j) {
      id += parseInt(Math.random() * 9) + 1;
    }
    return callback(null, id);
  };

  //Generate a random 32 bit number
  generateRandom32 = function() {
    var md5sum, str;
    str = ("" + (new Date().getTime()) + process.pid + (os.hostname())) + (1 + Math.random() * 1000000000);
    md5sum = crypto.createHash('md5');
    md5sum.update(str);
    return md5sum.digest().slice(0, 4).readUInt32BE(0);
  };

  //Resets the parameters associated with a stream
  resetStreamParams = function(stream) {
    stream.rtspUploadingClient = null;
    stream.videoSequenceNumber = 0;
    stream.audioSequenceNumber = 0;
    stream.lastVideoRTPTimestamp = null;
    stream.lastAudioRTPTimestamp = null;
    stream.videoRTPTimestampInterval = Math.round(90000 / stream.videoFrameRate);
    return stream.audioRTPTimestampInterval = stream.audioPeriodSize;
  };

  //Registers the event update_frame_rate with a call to the functin that changes
  //the frame rate
  avstreams.on('update_frame_rate', function(stream, frameRate) {
    return stream.videoRTPTimestampInterval = Math.round(90000 / frameRate);
  });

  //Called to create a stream, eventually calls resetStreamParams right above,
  //but also initializes number of active clients to 0
  avstreams.on('new', function(stream) {
    stream.rtspNumClients = 0;
    stream.rtspClients = {};
    return resetStreamParams(stream);
  });

  //Resets the stream parameters, but leaves the number of clients and their
  //order alone
  avstreams.on('reset', function(stream) {
    return resetStreamParams(stream);
  });

  //Constructor for the RTSPServer Object
  //As we have seen, it receives an httpHandler
  //from the streamServer.js file. It keeps track
  //of the clients uploading data to it separately
  //from those that it is streaming to. The port number
  //is initialized from configs, as we saw in stream_server.js
  //It registers callback functions to be made to the rtpParser
  //when h264_nal_units are received and when aac_access_units are
  //received. The event h264_nal_units in turn triggers the event
  //video, which we saw was handled in stream_server and the aac_access_units
  //triggers audio, which we also saw in stream_server. These in turn trigger
  //events which cause the stream to be updated, as we can see in the functions
  //onReceiveNalUnits and onReceiveAACUnits in stream_server.js
  //After that, some useful functions like getting the next sequence number, and timestamp
  //to be sent are defined.
  //Then there are the important functions sendVideoData and sendAudioData which in turn
  //call a function which behave slightly differently. sendVideoData has to check if it can
  //send one single NAL packet, or has to send a fragmented packet, handled in the functions 
  //below. Send audio data checks if the connection is via TCP or not, and both functions
  //ultimately write to their corresponding sockets.
  //Then we have the EOS function, which writes a goodbye message via the RTCP port to terminate 
  //the stream. 
  //
  //After those, we have the start function, and the comments explaining those will be written above it.
  RTSPServer = (function() {
    function RTSPServer(opts) {
      var ref, ref1;
      this.httpHandler = opts.httpHandler;
      this.numClients = 0;
      this.eventListeners = {};
      this.serverName = (ref = opts != null ? opts.serverName : void 0) != null ? ref : DEFAULT_SERVER_NAME;
      this.port = (ref1 = opts != null ? opts.port : void 0) != null ? ref1 : 8080;
      this.clients = {};
      this.httpSessions = {};
      this.rtspUploadingClients = {};
      this.highestClientID = 0;
      this.rtpParser = new rtp.RTPParser;
      this.rtpParser.on('h264_nal_units', (function(_this) {
        return function(streamId, nalUnits, rtpTimestamp) {
          var calculatedPTS, sendTime, stream;
          stream = avstreams.get(streamId);
          if (stream == null) {
            logger.warn("warn: No matching stream to id " + streamId);
            return;
          }
          if (stream.rtspUploadingClient == null) {
            logger.warn("warn: No uploading client associated with the stream " + stream.id);
            return;
          }
          sendTime = _this.getVideoSendTimeForUploadingRTPTimestamp(stream, rtpTimestamp);
          calculatedPTS = rtpTimestamp - stream.rtspUploadingClient.videoRTPStartTimestamp;
          return _this.emit('video', stream, nalUnits, calculatedPTS, calculatedPTS);
        };
      })(this));
      this.rtpParser.on('aac_access_units', (function(_this) {
        return function(streamId, accessUnits, rtpTimestamp) {
          var calculatedPTS, sendTime, stream;
          stream = avstreams.get(streamId);
          if (stream == null) {
            logger.warn("warn: No matching stream to id " + streamId);
            return;
          }
          if (stream.rtspUploadingClient == null) {
            logger.warn("warn: No uploading client associated with the stream " + stream.id);
            return;
          }
          sendTime = _this.getAudioSendTimeForUploadingRTPTimestamp(stream, rtpTimestamp);
          calculatedPTS = Math.round((rtpTimestamp - stream.rtspUploadingClient.audioRTPStartTimestamp) * 90000 / stream.audioClockRate);
          return _this.emit('audio', stream, accessUnits, calculatedPTS, calculatedPTS);
        };
      })(this));
    }

    RTSPServer.prototype.setServerName = function(name) {
      return this.serverName = name;
    };

    RTSPServer.prototype.getNextVideoSequenceNumber = function(stream) {
      var num;
      num = stream.videoSequenceNumber + 1;
      if (num > 65535) {
        num -= 65535;
      }
      return num;
    };

    RTSPServer.prototype.getNextAudioSequenceNumber = function(stream) {
      var num;
      num = stream.audioSequenceNumber + 1;
      if (num > 65535) {
        num -= 65535;
      }
      return num;
    };

    RTSPServer.prototype.getNextVideoRTPTimestamp = function(stream) {
      if (stream.lastVideoRTPTimestamp != null) {
        return stream.lastVideoRTPTimestamp + stream.videoRTPTimestampInterval;
      } else {
        return 0;
      }
    };

    RTSPServer.prototype.getNextAudioRTPTimestamp = function(stream) {
      if (stream.lastAudioRTPTimestamp != null) {
        return stream.lastAudioRTPTimestamp + stream.audioRTPTimestampInterval;
      } else {
        return 0;
      }
    };

    RTSPServer.prototype.getVideoRTPTimestamp = function(stream, time) {
      return Math.round(time * 90 % TIMESTAMP_ROUNDOFF);
    };

    RTSPServer.prototype.getAudioRTPTimestamp = function(stream, time) {
      if (stream.audioClockRate == null) {
        throw new Error("audioClockRate is null");
      }
      return Math.round(time * (stream.audioClockRate / 1000) % TIMESTAMP_ROUNDOFF);
    };

    RTSPServer.prototype.getVideoSendTimeForUploadingRTPTimestamp = function(stream, rtpTimestamp) {
      var ref, rtpDiff, timeDiff, videoTimestampInfo;
      videoTimestampInfo = (ref = stream.rtspUploadingClient) != null ? ref.uploadingTimestampInfo.video : void 0;
      if (videoTimestampInfo != null) {
        rtpDiff = rtpTimestamp - videoTimestampInfo.rtpTimestamp;
        timeDiff = rtpDiff / 90;
        return videoTimestampInfo.time + timeDiff;
      } else {
        return Date.now();
      }
    };

    RTSPServer.prototype.getAudioSendTimeForUploadingRTPTimestamp = function(stream, rtpTimestamp) {
      var audioTimestampInfo, ref, rtpDiff, timeDiff;
      audioTimestampInfo = (ref = stream.rtspUploadingClient) != null ? ref.uploadingTimestampInfo.audio : void 0;
      if (audioTimestampInfo != null) {
        rtpDiff = rtpTimestamp - audioTimestampInfo.rtpTimestamp;
        timeDiff = rtpDiff * 1000 / stream.audioClockRate;
        return audioTimestampInfo.time + timeDiff;
      } else {
        return Date.now();
      }
    };

    RTSPServer.prototype.sendVideoData = function(stream, nalUnits, pts, dts) {
      var i, isLastPacket, isPPSSent, isSPSSent, j, len, nalUnit, nalUnitType;
      isSPSSent = false;
      isPPSSent = false;
      for (i = j = 0, len = nalUnits.length; j < len; i = ++j) {
        nalUnit = nalUnits[i];
        isLastPacket = i === nalUnits.length - 1;
        nalUnitType = h264.getNALUnitType(nalUnit);
        if (config.dropH264AccessUnitDelimiter && (nalUnitType === h264.NAL_UNIT_TYPE_ACCESS_UNIT_DELIMITER)) {
          continue;
        }
        if (nalUnitType === h264.NAL_UNIT_TYPE_SPS) {
          isSPSSent = true;
        } else if (nalUnitType === h264.NAL_UNIT_TYPE_PPS) {
          isPPSSent = true;
        }
        if (nalUnitType === 5) {
          if (!isSPSSent) {
            if (stream.spsNALUnit != null) {
              this.sendNALUnitOverRTSP(stream, stream.spsNALUnit, pts, dts, false);
              isSPSSent = true;
            } else {
              logger.error("Error: SPS is not set");
            }
          }
          if (!isPPSSent) {
            if (stream.ppsNALUnit != null) {
              this.sendNALUnitOverRTSP(stream, stream.ppsNALUnit, pts, dts, false);
              isPPSSent = true;
            } else {
              logger.error("Error: PPS is not set");
            }
          }
        }
        this.sendNALUnitOverRTSP(stream, nalUnit, pts, dts, isLastPacket);
      }
    };

    RTSPServer.prototype.sendNALUnitOverRTSP = function(stream, nalUnit, pts, dts, marker) {
      if (nalUnit.length >= SINGLE_NAL_UNIT_MAX_SIZE) {
        return this.sendVideoPacketWithFragment(stream, nalUnit, pts, marker);
      } else {
        return this.sendVideoPacketAsSingleNALUnit(stream, nalUnit, pts, marker);
      }
    };

    RTSPServer.prototype.sendAudioData = function(stream, accessUnits, pts, dts) {
      var accessUnitLength, audioHeader, client, clientID, concatRawDataBlock, frameGroups, group, i, j, len, processedFrames, ref, rtpBuffer, rtpData, rtpTimePerFrame, timestamp, ts;
      if (stream.audioSampleRate == null) {
        throw new Error("audio sample rate has not been detected for stream " + stream.id);
      }
      if (stream.audioClockRate !== 90000) {
        timestamp = pts * stream.audioClockRate / 90000;
      } else {
        timestamp = pts;
      }
      rtpTimePerFrame = 1024;
      if (this.numClients === 0) {
        return;
      }
      if (stream.rtspNumClients === 0) {
        return;
      }
      frameGroups = rtp.groupAudioFrames(accessUnits);
      processedFrames = 0;
      for (i = j = 0, len = frameGroups.length; j < len; i = ++j) {
        group = frameGroups[i];
        concatRawDataBlock = Buffer.concat(group);
        if (++stream.audioSequenceNumber > 65535) {
          stream.audioSequenceNumber -= 65535;
        }
        ts = Math.round((timestamp + rtpTimePerFrame * processedFrames) % TIMESTAMP_ROUNDOFF);
        processedFrames += group.length;
        stream.lastAudioRTPTimestamp = (timestamp + rtpTimePerFrame * processedFrames) % TIMESTAMP_ROUNDOFF;
        rtpData = rtp.createRTPHeader({
          marker: true,
          payloadType: 96,
          sequenceNumber: stream.audioSequenceNumber,
          timestamp: ts,
          ssrc: null
        });
        accessUnitLength = concatRawDataBlock.length;
        audioHeader = rtp.createAudioHeader({
          accessUnits: group
        });
        rtpData = rtpData.concat(audioHeader);
        rtpBuffer = Buffer.concat([new Buffer(rtpData), concatRawDataBlock], rtp.RTP_HEADER_LEN + audioHeader.length + accessUnitLength);
        ref = stream.rtspClients;
        for (clientID in ref) {
          client = ref[clientID];
          if (client.isPlaying) {
            rtp.replaceSSRCInRTP(rtpBuffer, client.audioSSRC);
            client.audioPacketCount++;
            client.audioOctetCount += accessUnitLength;
            logger.tag('rtsp:out', "[rtsp:stream:" + stream.id + "] send audio to " + client.id + ": ts=" + ts + " pts=" + pts);
            if (client.useTCPForAudio) {
              if (client.useHTTP) {
                if (client.httpClientType === 'GET') {
                  this.sendDataByTCP(client.socket, client.audioTCPDataChannel, rtpBuffer);
                }
              } else {
                this.sendDataByTCP(client.socket, client.audioTCPDataChannel, rtpBuffer);
              }
            } else {
              if (client.clientAudioRTPPort != null) {
                this.audioRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientAudioRTPPort, client.ip, function(err, bytes) {
                  if (err) {
                    return logger.error("[audioRTPSend] error: " + err.message);
                  }
                });
              }
            }
          }
        }
      }
    };

    RTSPServer.prototype.sendEOS = function(stream) {
      var buf, client, clientID, ref, results;
      ref = stream.rtspClients;
      results = [];
      for (clientID in ref) {
        client = ref[clientID];
        logger.debug("[" + TAG + ":client=" + clientID + "] sending goodbye for stream " + stream.id);
        buf = new Buffer(rtp.createGoodbye({
          ssrcs: [client.videoSSRC]
        }));
        if (client.useTCPForVideo) {
          if (client.useHTTP) {
            if (client.httpClientType === 'GET') {
              this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
            }
          } else {
            this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
          }
        } else {
          if (client.clientVideoRTCPPort != null) {
            this.videoRTCPSocket.send(buf, 0, buf.length, client.clientVideoRTCPPort, client.ip, function(err, bytes) {
              if (err) {
                return logger.error("[videoRTCPSend] error: " + err.message);
              }
            });
          }
        }
        buf = new Buffer(rtp.createGoodbye({
          ssrcs: [client.audioSSRC]
        }));
        if (client.useTCPForAudio) {
          if (client.useHTTP) {
            if (client.httpClientType === 'GET') {
              results.push(this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf));
            } else {
              results.push(void 0);
            }
          } else {
            results.push(this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf));
          }
        } else {
          if (client.clientAudioRTCPPort != null) {
            results.push(this.audioRTCPSocket.send(buf, 0, buf.length, client.clientAudioRTCPPort, client.ip, function(err, bytes) {
              if (err) {
                return logger.error("[audioRTCPSend] error: " + err.message);
              }
            }));
          } else {
            results.push(void 0);
          }
        }
      }
      return results;
    };

    RTSPServer.prototype.dumpClients = function() {
      var client, clientID, ref;
      logger.raw("[rtsp/http: " + (Object.keys(this.clients).length) + " clients]");
      ref = this.clients;
      for (clientID in ref) {
        client = ref[clientID];
        logger.raw(" " + client.toString());
      }
    };

    RTSPServer.prototype.setLivePathConsumer = function(func) {
      return this.livePathConsumer = func;
    };

    //This is the function which actually opens the udp sockets on which
    //the RTSP server listens for RTP data.
    //Events are created for listening on each port.
    //The RTCP videosenderReport and audioSenderReport functions are defined here
    //Further functions are defined to read interleaved data, and the api at the very
    //end can create and deinterleave RTP packets.
    //The next important functions are the responses, to GET, POST, ANNOUNCE, OPTIONS,
    //RECORD,PLAY,PAUSE AND DESCRIBE.
    RTSPServer.prototype.start = function(opts, callback) {
      var ref, serverPort, udpAudioControlServer, udpAudioDataServer, udpVideoControlServer, udpVideoDataServer;
      serverPort = (ref = opts != null ? opts.port : void 0) != null ? ref : this.port;
      this.videoRTPSocket = dgram.createSocket('udp4');
      this.videoRTPSocket.bind(config.videoRTPServerPort);
      this.videoRTCPSocket = dgram.createSocket('udp4');
      this.videoRTCPSocket.bind(config.videoRTCPServerPort);
      this.audioRTPSocket = dgram.createSocket('udp4');
      this.audioRTPSocket.bind(config.audioRTPServerPort);
      this.audioRTCPSocket = dgram.createSocket('udp4');
      this.audioRTCPSocket.bind(config.audioRTCPServerPort);
      this.server = net.createServer((function(_this) {
        return function(c) {
          var id_str;
          _this.highestClientID++;
          id_str = 'c' + _this.highestClientID;
          logger.info("[" + TAG + ":client=" + id_str + "] connected");
          return generateNewSessionID(function(err, sessionID) {
            var client;
            if (err) {
              throw err;
            }
            client = _this.clients[id_str] = new RTSPClient({
              id: id_str,
              sessionID: sessionID,
              socket: c,
              ip: c.remoteAddress
            });
            _this.numClients++;
            c.setKeepAlive(true, 120000);
            c.clientID = id_str;
            c.isAuthenticated = false;
            c.requestCount = 0;
            c.responseCount = 0;
            c.on('close', function() {
              var _client, addr, e, ref1;
              logger.info("[" + TAG + ":client=" + id_str + "] disconnected");
              logger.debug("[" + TAG + ":client=" + id_str + "] teardown: session=" + sessionID);
              try {
                c.end();
              } catch (error) {
                e = error;
                logger.error("socket.end() error: " + e);
              }
              delete _this.clients[id_str];
              _this.numClients--;
              api.leaveClient(client);
              _this.stopSendingRTCP(client);
              ref1 = _this.rtspUploadingClients;
              for (addr in ref1) {
                _client = ref1[addr];
                if (_client === client) {
                  delete _this.rtspUploadingClients[addr];
                }
              }
              return _this.dumpClients();
            });
            c.buf = null;
            c.on('error', function(err) {
              logger.error("Socket error (" + c.clientID + "): " + err);
              return c.destroy();
            });
            return c.on('data', function(data) {
              return _this.handleOnData(c, data);
            });
          });
        };
      })(this));
      this.server.on('error', function(err) {
        return logger.error("[" + TAG + "] server error: " + err.message);
      });
      udpVideoDataServer = dgram.createSocket('udp4');
      udpVideoDataServer.on('error', function(err) {
        logger.error("[" + TAG + "] udp video data receiver error: " + err.message);
        throw err;
      });
      udpVideoDataServer.on('message', (function(_this) {
        return function(msg, rinfo) {
          var stream;
          stream = _this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'video-data');
          if (stream != null) {
            return _this.onUploadVideoData(stream, msg, rinfo);
          }
        };
      })(this));
      udpVideoDataServer.on('listening', function() {
        var addr;
        addr = udpVideoDataServer.address();
        return logger.debug("[" + TAG + "] udp video data receiver is listening on port " + addr.port);
      });
      udpVideoDataServer.bind(config.rtspVideoDataUDPListenPort);
      udpVideoControlServer = dgram.createSocket('udp4');
      udpVideoControlServer.on('error', function(err) {
        logger.error("[" + TAG + "] udp video control receiver error: " + err.message);
        throw err;
      });
      udpVideoControlServer.on('message', (function(_this) {
        return function(msg, rinfo) {
          var stream;
          stream = _this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'video-control');
          if (stream != null) {
            return _this.onUploadVideoControl(stream, msg, rinfo);
          }
        };
      })(this));
      udpVideoControlServer.on('listening', function() {
        var addr;
        addr = udpVideoControlServer.address();
        return logger.debug("[" + TAG + "] udp video control receiver is listening on port " + addr.port);
      });
      udpVideoControlServer.bind(config.rtspVideoControlUDPListenPort);
      udpAudioDataServer = dgram.createSocket('udp4');
      udpAudioDataServer.on('error', function(err) {
        logger.error("[" + TAG + "] udp audio data receiver error: " + err.message);
        throw err;
      });
      udpAudioDataServer.on('message', (function(_this) {
        return function(msg, rinfo) {
          var stream;
          stream = _this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'audio-data');
          if (stream != null) {
            return _this.onUploadAudioData(stream, msg, rinfo);
          }
        };
      })(this));
      udpAudioDataServer.on('listening', function() {
        var addr;
        addr = udpAudioDataServer.address();
        return logger.debug("[" + TAG + "] udp audio data receiver is listening on port " + addr.port);
      });
      udpAudioDataServer.bind(config.rtspAudioDataUDPListenPort);
      udpAudioControlServer = dgram.createSocket('udp4');
      udpAudioControlServer.on('error', function(err) {
        logger.error("[" + TAG + "] udp audio control receiver error: " + err.message);
        throw err;
      });
      udpAudioControlServer.on('message', (function(_this) {
        return function(msg, rinfo) {
          var stream;
          stream = _this.getStreamByRTSPUDPAddress(rinfo.address, rinfo.port, 'audio-control');
          if (stream != null) {
            return _this.onUploadAudioControl(stream, msg, rinfo);
          }
        };
      })(this));
      udpAudioControlServer.on('listening', function() {
        var addr;
        addr = udpAudioControlServer.address();
        return logger.debug("[" + TAG + "] udp audio control receiver is listening on port " + addr.port);
      });
      udpAudioControlServer.bind(config.rtspAudioControlUDPListenPort);
      logger.debug("[" + TAG + "] starting server on port " + serverPort);
      return this.server.listen(serverPort, '0.0.0.0', 511, (function(_this) {
        return function() {
          logger.info("[" + TAG + "] server started on port " + serverPort);
          return typeof callback === "function" ? callback() : void 0;
        };
      })(this));
    };

    RTSPServer.prototype.stop = function(callback) {
      var ref;
      return (ref = this.server) != null ? ref.close(callback) : void 0;
    };

    RTSPServer.prototype.on = function(event, listener) {
      if (this.eventListeners[event] != null) {
        this.eventListeners[event].push(listener);
      } else {
        this.eventListeners[event] = [listener];
      }
    };

    RTSPServer.prototype.emit = function() {
      var args, event, j, len, listener, ref;
      event = arguments[0], args = 2 <= arguments.length ? slice.call(arguments, 1) : [];
      if (this.eventListeners[event] != null) {
        ref = this.eventListeners[event];
        for (j = 0, len = ref.length; j < len; j++) {
          listener = ref[j];
          listener.apply(null, args);
        }
      }
    };

    RTSPServer.getStreamIdFromUri = function(uri, removeDepthFromEnd) {
      var e, pathname, slashPos;
      if (removeDepthFromEnd == null) {
        removeDepthFromEnd = 0;
      }
      try {
        pathname = url.parse(uri).pathname;
      } catch (error) {
        e = error;
        return null;
      }
      if ((pathname != null) && pathname.length > 0) {
        pathname = pathname.slice(1);
        if (pathname[pathname.length - 1] === '/') {
          pathname = pathname.slice(0, +(pathname.length - 2) + 1 || 9e9);
        }
        while (removeDepthFromEnd > 0) {
          slashPos = pathname.lastIndexOf('/');
          if (slashPos === -1) {
            break;
          }
          pathname = pathname.slice(0, slashPos);
          removeDepthFromEnd--;
        }
      }
      return pathname;
    };

    RTSPServer.prototype.getStreamByRTSPUDPAddress = function(addr, port, channelType) {
      var client;
      client = this.rtspUploadingClients[addr + ':' + port];
      if (client != null) {
        return client.uploadingStream;
      }
      return null;
    };

    RTSPServer.prototype.getStreamByUri = function(uri) {
      var streamId;
      streamId = RTSPServer.getStreamIdFromUri(uri);
      if (streamId != null) {
        return avstreams.get(streamId);
      } else {
        return null;
      }
    };

    RTSPServer.prototype.sendVideoSenderReport = function(stream, client) {
      var buf, rtpTime, time;
      if (stream.timeAtVideoStart == null) {
        return;
      }
      time = new Date().getTime();
      rtpTime = this.getVideoRTPTimestamp(stream, time - stream.timeAtVideoStart);
      if (DEBUG_OUTGOING_RTCP) {
        logger.info("video sender report: rtpTime=" + rtpTime + " time=" + time + " timeAtVideoStart=" + stream.timeAtVideoStart);
      }
      buf = new Buffer(rtp.createSenderReport({
        time: time,
        rtpTime: rtpTime,
        ssrc: client.videoSSRC,
        packetCount: client.videoPacketCount,
        octetCount: client.videoOctetCount
      }));
      if (client.useTCPForVideo) {
        if (client.useHTTP) {
          if (client.httpClientType === 'GET') {
            return this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
          }
        } else {
          return this.sendDataByTCP(client.socket, client.videoTCPControlChannel, buf);
        }
      } else {
        if (client.clientVideoRTCPPort != null) {
          return this.videoRTCPSocket.send(buf, 0, buf.length, client.clientVideoRTCPPort, client.ip, function(err, bytes) {
            if (err) {
              return logger.error("[videoRTCPSend] error: " + err.message);
            }
          });
        }
      }
    };

    RTSPServer.prototype.sendAudioSenderReport = function(stream, client) {
      var buf, rtpTime, time;
      if (stream.timeAtAudioStart == null) {
        return;
      }
      time = new Date().getTime();
      rtpTime = this.getAudioRTPTimestamp(stream, time - stream.timeAtAudioStart);
      if (DEBUG_OUTGOING_RTCP) {
        logger.info("audio sender report: rtpTime=" + rtpTime + " time=" + time + " timeAtAudioStart=" + stream.timeAtAudioStart);
      }
      buf = new Buffer(rtp.createSenderReport({
        time: time,
        rtpTime: rtpTime,
        ssrc: client.audioSSRC,
        packetCount: client.audioPacketCount,
        octetCount: client.audioOctetCount
      }));
      if (client.useTCPForAudio) {
        if (client.useHTTP) {
          if (client.httpClientType === 'GET') {
            return this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf);
          }
        } else {
          return this.sendDataByTCP(client.socket, client.audioTCPControlChannel, buf);
        }
      } else {
        if (client.clientAudioRTCPPort != null) {
          return this.audioRTCPSocket.send(buf, 0, buf.length, client.clientAudioRTCPPort, client.ip, function(err, bytes) {
            if (err) {
              return logger.error("[audioRTCPSend] error: " + err.message);
            }
          });
        }
      }
    };

    RTSPServer.prototype.stopSendingRTCP = function(client) {
      if (client.timeoutID != null) {
        clearTimeout(client.timeoutID);
        return client.timeoutID = null;
      }
    };

    RTSPServer.prototype.sendSenderReports = function(stream, client) {
      if (this.clients[client.id] == null) {
        this.stopSendingRTCP(client);
        return;
      }
      if (stream.isAudioStarted) {
        this.sendAudioSenderReport(stream, client);
      }
      if (stream.isVideoStarted) {
        this.sendVideoSenderReport(stream, client);
      }
      return client.timeoutID = setTimeout((function(_this) {
        return function() {
          return _this.sendSenderReports(stream, client);
        };
      })(this), config.rtcpSenderReportIntervalMs);
    };

    RTSPServer.prototype.startSendingRTCP = function(stream, client) {
      this.stopSendingRTCP(client);
      return this.sendSenderReports(stream, client);
    };

    RTSPServer.prototype.onReceiveVideoRTCP = function(buf) {};

    RTSPServer.prototype.onReceiveAudioRTCP = function(buf) {};

    RTSPServer.prototype.sendDataByTCP = function(socket, channel, rtpBuffer) {
      var rtpLen, tcpHeader;
      rtpLen = rtpBuffer.length;
      tcpHeader = api.createInterleavedHeader({
        channel: channel,
        payloadLength: rtpLen
      });
      return socket.write(Buffer.concat([tcpHeader, rtpBuffer], api.INTERLEAVED_HEADER_LEN + rtpBuffer.length));
    };

    RTSPServer.prototype.handleTunneledPOSTData = function(client, data, callback) {
      var base64Buf, decodedBuf, decodedRequest, delimiterPos, div, interleavedData, postData, processRemainingBuffer, remainingPostData, req;
      if (data == null) {
        data = '';
      }
      if (client.postBase64Buf != null) {
        base64Buf = client.postBase64Buf + data;
      } else {
        base64Buf = data;
      }
      if (base64Buf.length > 0) {
        div = base64Buf.length % 4;
        if (div !== 0) {
          client.postBase64Buf = base64Buf.slice(-div);
          base64Buf = base64Buf.slice(0, -div);
        } else {
          client.postBase64Buf = null;
        }
        decodedBuf = new Buffer(base64Buf, 'base64');
      } else {
        decodedBuf = new Buffer([]);
      }
      if (client.postBuf != null) {
        postData = Buffer.concat([client.postBuf, decodedBuf]);
        client.postBuf = null;
      } else {
        postData = decodedBuf;
      }
      if (postData.length === 0) {
        if (typeof callback === "function") {
          callback(null);
        }
        return;
      }
      processRemainingBuffer = (function(_this) {
        return function() {
          if ((client.postBase64Buf != null) || (client.postBuf != null)) {
            _this.handleTunneledPOSTData(client, '', callback);
          } else {
            if (typeof callback === "function") {
              callback(null);
            }
          }
        };
      })(this);
      if (config.enableRTSP && (postData[0] === api.INTERLEAVED_SIGN)) {
        interleavedData = api.getInterleavedData(postData);
        if (interleavedData == null) {
          client.postBuf = postData;
          if (typeof callback === "function") {
            callback(null);
          }
          return;
        }
        this.onInterleavedRTPPacketFromClient(client, interleavedData);
        if (postData.length > interleavedData.totalLength) {
          client.postBuf = client.buf.slice(interleavedData.totalLength);
        }
        return processRemainingBuffer();
      } else {
        delimiterPos = Bits.searchBytesInArray(postData, CRLF_CRLF);
        if (delimiterPos === -1) {
          client.postBuf = postData;
          if (typeof callback === "function") {
            callback(null);
          }
          return;
        }
        decodedRequest = postData.slice(0, delimiterPos).toString('utf8');
        remainingPostData = postData.slice(delimiterPos + CRLF_CRLF.length);
        req = http.parseRequest(decodedRequest);
        if (req == null) {
          logger.error("Unable to parse request: " + decodedRequest);
          if (typeof callback === "function") {
            callback(new Error("malformed request"));
          }
          return;
        }
        if (req.headers['content-length'] != null) {
          req.contentLength = parseInt(req.headers['content-length']);
          if (remainingPostData.length < req.contentLength) {
            client.postBuf = postData;
            if (typeof callback === "function") {
              callback(null);
            }
            return;
          }
          if (remainingPostData.length > req.contentLength) {
            req.rawbody = remainingPostData.slice(0, req.contentLength);
            client.postBuf = remainingPostData.slice(req.contentLength);
          } else {
            req.rawbody = remainingPostData;
          }
        } else if (remainingPostData.length > 0) {
          client.postBuf = remainingPostData;
        }
        if (DEBUG_HTTP_TUNNEL) {
          logger.info("===request (HTTP tunneled/decoded)===");
          process.stdout.write(decodedRequest);
          logger.info("=============");
        }
        return this.respond(client.socket, req, function(err, output) {
          if (err) {
            logger.error("[respond] Error: " + err);
            if (typeof callback === "function") {
              callback(err);
            }
            return;
          }
          if (output != null) {
            if (DEBUG_HTTP_TUNNEL) {
              logger.info("===response (HTTP tunneled)===");
              process.stdout.write(output);
              logger.info("=============");
            }
            client.getClient.socket.write(output);
          } else {
            if (DEBUG_HTTP_TUNNEL) {
              logger.info("===empty response (HTTP tunneled)===");
            }
          }
          return processRemainingBuffer();
        });
      }
    };

    RTSPServer.prototype.onInterleavedRTPPacketFromClient = function(client, interleavedData) {
      var senderInfo, stream;
      if (client.uploadingStream != null) {
        stream = client.uploadingStream;
        senderInfo = {
          address: null,
          port: null
        };
        switch (interleavedData.channel) {
          case stream.rtspUploadingClient.uploadingChannels.videoData:
            return this.onUploadVideoData(stream, interleavedData.data, senderInfo);
          case stream.rtspUploadingClient.uploadingChannels.videoControl:
            return this.onUploadVideoControl(stream, interleavedData.data, senderInfo);
          case stream.rtspUploadingClient.uploadingChannels.audioData:
            return this.onUploadAudioData(stream, interleavedData.data, senderInfo);
          case stream.rtspUploadingClient.uploadingChannels.audioControl:
            return this.onUploadAudioControl(stream, interleavedData.data, senderInfo);
          default:
            return logger.error("Error: unknown interleaved channel: " + interleavedData.channel);
        }
      }
    };

    RTSPServer.prototype.handleOnData = function(c, data) {
      var buf, bufString, client, id_str, interleavedData, req;
      id_str = c.clientID;
      if (this.clients[id_str] == null) {
        logger.error("error: invalid client ID: " + id_str);
        return;
      }
      client = this.clients[id_str];
      if (client.isSendingPOST) {
        this.handleTunneledPOSTData(client, data.toString('utf8'));
        return;
      }
      if (c.buf != null) {
        c.buf = Buffer.concat([c.buf, data], c.buf.length + data.length);
      } else {
        c.buf = data;
      }
      if (c.buf[0] === api.INTERLEAVED_SIGN) {
        interleavedData = api.getInterleavedData(c.buf);
        if (interleavedData == null) {
          return;
        }
        if (c.buf.length > interleavedData.totalLength) {
          c.buf = c.buf.slice(interleavedData.totalLength);
        } else {
          c.buf = null;
        }
        this.onInterleavedRTPPacketFromClient(client, interleavedData);
        if (c.buf != null) {
          buf = c.buf;
          c.buf = null;
          this.handleOnData(c, buf);
        }
        return;
      }
      if (c.ongoingRequest != null) {
        req = c.ongoingRequest;
        req.rawbody = Buffer.concat([req.rawbody, data], req.rawbody.length + data.length);
        if (req.rawbody.length < req.contentLength) {
          return;
        }
        req.socket = c;
        if (req.rawbody.length > req.contentLength) {
          c.buf = req.rawbody.slice(req.contentLength);
          req.rawbody = req.rawbody.slice(0, req.contentLength);
        } else {
          c.buf = null;
        }
        req.body = req.rawbody.toString('utf8');
        if (DEBUG_RTSP) {
          logger.info("===RTSP/HTTP request (cont) from " + id_str + "===");
          if (DEBUG_RTSP_HEADERS_ONLY) {
            logger.info("(redacted)");
          } else {
            process.stdout.write(data.toString('utf8'));
          }
          logger.info("==================");
        }
      } else {
        bufString = c.buf.toString('utf8');
        if (bufString.indexOf('\r\n\r\n') === -1) {
          return;
        }
        if (DEBUG_RTSP) {
          logger.info("===RTSP/HTTP request from " + id_str + "===");
          if (DEBUG_RTSP_HEADERS_ONLY) {
            process.stdout.write(bufString.replace(/\r\n\r\n[\s\S]*/, '\n'));
          } else {
            process.stdout.write(bufString);
          }
          logger.info("==================");
        }
        req = http.parseRequest(bufString);
        if (req == null) {
          logger.error("Unable to parse request: " + bufString);
          c.buf = null;
          return;
        }
        req.rawbody = c.buf.slice(req.headerBytes + 4);
        req.socket = c;
        if (req.headers['content-length'] != null) {
          if (req.headers['content-type'] === 'application/x-rtsp-tunnelled') {
            req.contentLength = 0;
          } else {
            req.contentLength = parseInt(req.headers['content-length']);
          }
          if (req.rawbody.length < req.contentLength) {
            c.ongoingRequest = req;
            return;
          }
          if (req.rawbody.length > req.contentLength) {
            c.buf = req.rawbody.slice(req.contentLength);
            req.rawbody = req.rawbody.slice(0, req.contentLength);
          } else {
            c.buf = null;
          }
        } else {
          if (req.rawbody.length > 0) {
            c.buf = req.rawbody;
          } else {
            c.buf = null;
          }
        }
      }
      c.ongoingRequest = null;
      return this.respond(c, req, (function(_this) {
        return function(err, output, resultOpts) {
          var delimPos, headerBytes, i, j, len, out;
          if (err) {
            logger.error("[respond] Error: " + err);
            return;
          }
          if (output != null) {
            if (DEBUG_RTSP) {
              logger.info("===RTSP/HTTP response to " + id_str + "===");
            }
            if (output instanceof Array) {
              for (i = j = 0, len = output.length; j < len; i = ++j) {
                out = output[i];
                if (DEBUG_RTSP) {
                  logger.info(out);
                }
                c.write(out);
              }
            } else {
              if (DEBUG_RTSP) {
                if (DEBUG_RTSP_HEADERS_ONLY) {
                  delimPos = Bits.searchBytesInArray(output, [0x0d, 0x0a, 0x0d, 0x0a]);
                  if (delimPos !== -1) {
                    headerBytes = output.slice(0, +(delimPos + 1) + 1 || 9e9);
                  } else {
                    headerBytes = output;
                  }
                  process.stdout.write(headerBytes);
                } else {
                  process.stdout.write(output);
                }
              }
              c.write(output);
            }
            if (DEBUG_RTSP) {
              logger.info("===================");
            }
          } else {
            if (DEBUG_RTSP) {
              logger.info("===RTSP/HTTP empty response to " + id_str + "===");
            }
          }
          if (resultOpts != null ? resultOpts.close : void 0) {
            c.end();
          }
          if (c.buf != null) {
            buf = c.buf;
            c.buf = null;
            return _this.handleOnData(c, buf);
          }
        };
      })(this));
    };

    RTSPServer.prototype.sendVideoPacketWithFragment = function(stream, nalUnit, timestamp, marker) {
      var client, clientID, fragmentNumber, isKeyFrame, nalUnitLen, nalUnitType, nal_ref_idc, ref, ref1, rtpBuffer, rtpData, thisNalUnit, thisNalUnitLen, ts;
      if (marker == null) {
        marker = true;
      }
      ts = timestamp % TIMESTAMP_ROUNDOFF;
      stream.lastVideoRTPTimestamp = ts;
      if (this.numClients === 0) {
        return;
      }
      if (stream.rtspNumClients === 0) {
        return;
      }
      nalUnitType = nalUnit[0] & 0x1f;
      isKeyFrame = nalUnitType === 5;
      nal_ref_idc = nalUnit[0] & 0x60;
      nalUnit = nalUnit.slice(1);
      fragmentNumber = 0;
      while (nalUnit.length > SINGLE_NAL_UNIT_MAX_SIZE) {
        if (++stream.videoSequenceNumber > 65535) {
          stream.videoSequenceNumber -= 65535;
        }
        fragmentNumber++;
        thisNalUnit = nalUnit.slice(0, SINGLE_NAL_UNIT_MAX_SIZE);
        nalUnit = nalUnit.slice(SINGLE_NAL_UNIT_MAX_SIZE);
        rtpData = rtp.createRTPHeader({
          marker: false,
          payloadType: 97,
          sequenceNumber: stream.videoSequenceNumber,
          timestamp: ts,
          ssrc: null
        });
        rtpData = rtpData.concat(rtp.createFragmentationUnitHeader({
          nal_ref_idc: nal_ref_idc,
          nal_unit_type: nalUnitType,
          isStart: fragmentNumber === 1,
          isEnd: false
        }));
        thisNalUnitLen = thisNalUnit.length;
        rtpBuffer = Buffer.concat([new Buffer(rtpData), thisNalUnit], rtp.RTP_HEADER_LEN + 2 + thisNalUnitLen);
        ref = stream.rtspClients;
        for (clientID in ref) {
          client = ref[clientID];
          if (client.isWaitingForKeyFrame && isKeyFrame) {
            client.isPlaying = true;
            client.isWaitingForKeyFrame = false;
          }
          if (client.isPlaying) {
            rtp.replaceSSRCInRTP(rtpBuffer, client.videoSSRC);
            logger.tag('rtsp:out', "[rtsp:stream:" + stream.id + "] send video to " + client.id + ": fragment n=" + fragmentNumber + " timestamp=" + ts + " bytes=" + rtpBuffer.length + " marker=false keyframe=" + isKeyFrame);
            client.videoPacketCount++;
            client.videoOctetCount += thisNalUnitLen;
            if (client.useTCPForVideo) {
              if (client.useHTTP) {
                if (client.httpClientType === 'GET') {
                  this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
                }
              } else {
                this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
              }
            } else {
              if (client.clientVideoRTPPort != null) {
                this.videoRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientVideoRTPPort, client.ip, function(err, bytes) {
                  if (err) {
                    return logger.error("[videoRTPSend] error: " + err.message);
                  }
                });
              }
            }
          }
        }
      }
      if (++stream.videoSequenceNumber > 65535) {
        stream.videoSequenceNumber -= 65535;
      }
      rtpData = rtp.createRTPHeader({
        marker: marker,
        payloadType: 97,
        sequenceNumber: stream.videoSequenceNumber,
        timestamp: ts,
        ssrc: null
      });
      rtpData = rtpData.concat(rtp.createFragmentationUnitHeader({
        nal_ref_idc: nal_ref_idc,
        nal_unit_type: nalUnitType,
        isStart: false,
        isEnd: true
      }));
      nalUnitLen = nalUnit.length;
      rtpBuffer = Buffer.concat([new Buffer(rtpData), nalUnit], rtp.RTP_HEADER_LEN + 2 + nalUnitLen);
      ref1 = stream.rtspClients;
      for (clientID in ref1) {
        client = ref1[clientID];
        if (client.isWaitingForKeyFrame && isKeyFrame) {
          client.isPlaying = true;
          client.isWaitingForKeyFrame = false;
        }
        if (client.isPlaying) {
          rtp.replaceSSRCInRTP(rtpBuffer, client.videoSSRC);
          client.videoPacketCount++;
          client.videoOctetCount += nalUnitLen;
          logger.tag('rtsp:out', "[rtsp:stream:" + stream.id + "] send video to " + client.id + ": fragment-last n=" + (fragmentNumber + 1) + " timestamp=" + ts + " bytes=" + rtpBuffer.length + " marker=" + marker + " keyframe=" + isKeyFrame);
          if (client.useTCPForVideo) {
            if (client.useHTTP) {
              if (client.httpClientType === 'GET') {
                this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
              }
            } else {
              this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
            }
          } else {
            if (client.clientVideoRTPPort != null) {
              this.videoRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientVideoRTPPort, client.ip, function(err, bytes) {
                if (err) {
                  return logger.error("[videoRTPSend] error: " + err.message);
                }
              });
            }
          }
        }
      }
    };

    RTSPServer.prototype.sendVideoPacketAsSingleNALUnit = function(stream, nalUnit, timestamp, marker) {
      var client, clientID, isKeyFrame, nalUnitLen, nalUnitType, ref, rtpBuffer, rtpHeader, ts;
      if (marker == null) {
        marker = true;
      }
      if (++stream.videoSequenceNumber > 65535) {
        stream.videoSequenceNumber -= 65535;
      }
      ts = timestamp % TIMESTAMP_ROUNDOFF;
      stream.lastVideoRTPTimestamp = ts;
      nalUnitType = nalUnit[0] & 0x1f;
      if (this.numClients === 0) {
        return;
      }
      if (stream.rtspNumClients === 0) {
        return;
      }
      isKeyFrame = nalUnitType === 5;
      rtpHeader = rtp.createRTPHeader({
        marker: marker,
        payloadType: 97,
        sequenceNumber: stream.videoSequenceNumber,
        timestamp: ts,
        ssrc: null
      });
      nalUnitLen = nalUnit.length;
      rtpBuffer = Buffer.concat([new Buffer(rtpHeader), nalUnit], rtp.RTP_HEADER_LEN + nalUnitLen);
      ref = stream.rtspClients;
      for (clientID in ref) {
        client = ref[clientID];
        if (client.isWaitingForKeyFrame && isKeyFrame) {
          client.isPlaying = true;
          client.isWaitingForKeyFrame = false;
        }
        if (client.isPlaying) {
          rtp.replaceSSRCInRTP(rtpBuffer, client.videoSSRC);
          client.videoPacketCount++;
          client.videoOctetCount += nalUnitLen;
          logger.tag('rtsp:out', "[rtsp:stream:" + stream.id + "] send video to " + client.id + ": single timestamp=" + timestamp + " keyframe=" + isKeyFrame);
          if (client.useTCPForVideo) {
            if (client.useHTTP) {
              if (client.httpClientType === 'GET') {
                this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
              }
            } else {
              this.sendDataByTCP(client.socket, client.videoTCPDataChannel, rtpBuffer);
            }
          } else {
            if (client.clientVideoRTPPort != null) {
              this.videoRTPSocket.send(rtpBuffer, 0, rtpBuffer.length, client.clientVideoRTPPort, client.ip, function(err, bytes) {
                if (err) {
                  return logger.error("[videoRTPSend] error: " + err.message);
                }
              });
            }
          }
        }
      }
    };

    RTSPServer.getISO8601DateString = function() {
      var d, str;
      d = new Date;
      str = ((d.getUTCFullYear()) + "-" + (pad(2, d.getUTCMonth() + 1)) + "-" + (pad(2, d.getUTCDate())) + "T") + ((pad(2, d.getUTCHours())) + ":" + (pad(2, d.getUTCMinutes())) + ":" + (pad(2, d.getUTCSeconds())) + ".") + ((pad(4, d.getUTCMilliseconds())) + "Z");
      return str;
    };

    RTSPServer.prototype.consumePathname = function(uri, callback) {
      var authSuccess, pathname;
      if (this.livePathConsumer != null) {
        return this.livePathConsumer(uri, callback);
      } else {
        pathname = url.parse(uri).pathname.slice(1);
        authSuccess = true;
        if (authSuccess) {
          return callback(null);
        } else {
          return callback(new Error('Invalid access'));
        }
      }
    };

    //These functions are called when there are failures with the requests.
    RTSPServer.prototype.respondWithUnsupportedTransport = function(callback, headers) {
      var name, res, value;
      res = 'RTSP/1.0 461 Unsupported Transport\n';
      if (headers != null) {
        for (name in headers) {
          value = headers[name];
          res += name + ": " + value + "\n";
        }
      }
      res += '\n';
      return callback(null, res.replace(/\n/g, '\r\n'));
    };

    RTSPServer.prototype.notFound = function(protocol, opts, callback) {
      var res;
      res = protocol + "/1.0 404 Not Found\nContent-Length: 9\nContent-Type: text/plain\n";
      if (opts != null ? opts.keepalive : void 0) {
        res += "Connection: keep-alive\n";
      } else {
        res += "Connection: close\n";
      }
      res += "\nNot Found";
      return callback(null, res.replace(/\n/g, "\r\n"));
    };

    RTSPServer.prototype.respondWithNotFound = function(req, protocol, callback) {
      var ref, res;
      if (protocol == null) {
        protocol = 'RTSP';
      }
      res = (protocol + "/1.0 404 Not Found\nDate: " + (api.getDateHeader()) + "\nContent-Length: 9\nContent-Type: text/plain\n\nNot Found").replace(/\n/g, "\r\n");
      return callback(null, res, {
        close: ((ref = req.headers.connection) != null ? ref.toLowerCase() : void 0) !== 'keep-alive'
      });
    };

    //This is the first important function for the RTSP session.
    //It responds to an OPTIONS request from the client
    //by sending in SDP that the server has status 200, and 
    //the options it can send are DESCRIBE,SETUP,PLAY,PAUSE,ANNOUNCE,RECORD
    RTSPServer.prototype.respondOptions = function(socket, req, callback) {
      var ref, res;
      res = ("RTSP/1.0 200 OK\nCSeq: " + ((ref = req.headers.cseq) != null ? ref : 0) + "\nPublic: DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, ANNOUNCE, RECORD\n\n").replace(/\n/g, "\r\n");
      return callback(null, res);
    };

    //This responds to a post request from the client, if we are using rtsp over http
    RTSPServer.prototype.respondPost = function(socket, req, callback) {
      var client, getClient, pathname;
      client = this.clients[socket.clientID];
      pathname = url.parse(req.uri).pathname;
      if (config.enableRTSP) {
        if (this.httpSessions[req.headers['x-sessioncookie']] == null) {
          if (this.httpHandler != null) {
            this.respondWithNotFound(req, 'HTTP', callback);
          } else {
            callback(null, null, {
              close: true
            });
          }
          return;
        }
        socket.isAuthenticated = true;
        client.sessionCookie = req.headers['x-sessioncookie'];
        this.httpSessions[client.sessionCookie].post = client;
        getClient = this.httpSessions[client.sessionCookie].get;
        getClient.postClient = client;
        client.getClient = getClient;
        client.useHTTP = true;
        client.httpClientType = 'POST';
        client.isSendingPOST = true;
        if (req.body != null) {
          this.handleTunneledPOSTData(client, req.body);
        }
      } else if (this.httpHandler != null) {
        this.httpHandler.handlePath(pathname, req, function(err, output) {
          var ref;
          return callback(err, output, {
            close: ((ref = req.headers.connection) != null ? ref.toLowerCase() : void 0) !== 'keep-alive'
          });
        });
      } else {
        callback(null, null, {
          close: true
        });
      }
    };

    //This handles a tunneled Get request
    RTSPServer.prototype.respondGet = function(socket, req, callback) {
      var client, liveRegex, match, pathname, recordedRegex;
      liveRegex = new RegExp("^/" + config.liveApplicationName + "/(.*)$");
      recordedRegex = new RegExp("^/" + config.recordedApplicationName + "/(.*)$");
      client = this.clients[socket.clientID];
      pathname = url.parse(req.uri).pathname;
      if (config.enableRTSP && ((match = liveRegex.exec(req.uri)) != null)) {
        this.consumePathname(req.uri, (function(_this) {
          return function(err) {
            var postClient, res;
            if (err) {
              logger.warn("Failed to consume pathname: " + err);
              _this.respondWithNotFound(req, 'HTTP', callback);
              return;
            }
            client.sessionCookie = req.headers['x-sessioncookie'];
            client.useHTTP = true;
            client.httpClientType = 'GET';
            if (_this.httpSessions[client.sessionCookie] != null) {
              postClient = _this.httpSessions[client.sessionCookie].post;
              if (postClient != null) {
                postClient.getClient = client;
                client.postClient = postClient;
              }
            } else {
              _this.httpSessions[client.sessionCookie] = {};
            }
            _this.httpSessions[client.sessionCookie].get = client;
            socket.isAuthenticated = true;
            res = ("HTTP/1.0 200 OK\nServer: " + _this.serverName + "\nConnection: close\nDate: " + (api.getDateHeader()) + "\nCache-Control: no-store\nPragma: no-cache\nContent-Type: application/x-rtsp-tunnelled\n\n").replace(/\n/g, "\r\n");
            return callback(null, res);
          };
        })(this));
      } else if (config.enableRTSP && ((match = recordedRegex.exec(req.uri)) != null)) {
        this.consumePathname(req.uri, (function(_this) {
          return function(err) {
            var postClient, res;
            if (err) {
              logger.warn("Failed to consume pathname: " + err);
              _this.respondWithNotFound(req, 'HTTP', callback);
              return;
            }
            client.sessionCookie = req.headers['x-sessioncookie'];
            client.useHTTP = true;
            client.httpClientType = 'GET';
            if (_this.httpSessions[client.sessionCookie] != null) {
              postClient = _this.httpSessions[client.sessionCookie].post;
              if (postClient != null) {
                postClient.getClient = client;
                client.postClient = postClient;
              }
            } else {
              _this.httpSessions[client.sessionCookie] = {};
            }
            _this.httpSessions[client.sessionCookie].get = client;
            socket.isAuthenticated = true;
            res = ("HTTP/1.0 200 OK\nServer: " + _this.serverName + "\nConnection: close\nDate: " + (api.getDateHeader()) + "\nCache-Control: no-store\nPragma: no-cache\nContent-Type: application/x-rtsp-tunnelled\n\n").replace(/\n/g, "\r\n");
            return callback(null, res);
          };
        })(this));
      } else if (this.httpHandler != null) {
        this.httpHandler.handlePath(pathname, req, function(err, output) {
          var ref;
          return callback(err, output, {
            close: ((ref = req.headers.connection) != null ? ref.toLowerCase() : void 0) !== 'keep-alive'
          });
        });
      } else {
        callback(null, null, {
          close: true
        });
      }
    };

    //This function handles the DESCRIBE request
    //It fills out an SDP object which describes the streams
    //that will be sent out to the one requesting.
    //This includes data on which port the server will be streaming data to,
    //the protocol being used, the format, the expected start and end timestamps, the 
    //average bitrate etc.
    RTSPServer.prototype.respondDescribe = function(socket, req, callback) {
      var client;
      client = this.clients[socket.clientID];
      return this.consumePathname(req.uri, (function(_this) {
        return function(err) {
          var ascInfo, body, dateHeader, e, res, sdpData, stream, streamId;
          if (err) {
            _this.respondWithNotFound(req, 'RTSP', callback);
            return;
          }
          socket.isAuthenticated = true;
          client.bandwidth = req.headers.bandwidth;
          streamId = RTSPServer.getStreamIdFromUri(req.uri);
          stream = null;
          if (streamId != null) {
            stream = avstreams.get(streamId);
          }
          client.stream = stream;
          if (stream == null) {
            logger.info("[" + TAG + ":client=" + client.id + "] requested stream not found: " + streamId);
            _this.respondWithNotFound(req, 'RTSP', callback);
            return;
          }
          sdpData = {
            username: '-',
            sessionID: client.sessionID,
            sessionVersion: client.sessionID,
            addressType: 'IP4',
            unicastAddress: api.getMeaningfulIPTo(socket)
          };
          if (stream.isAudioStarted) {
            sdpData.hasAudio = true;
            sdpData.audioPayloadType = 96;
            sdpData.audioEncodingName = 'mpeg4-generic';
            sdpData.audioClockRate = stream.audioClockRate;
            sdpData.audioChannels = stream.audioChannels;
            sdpData.audioSampleRate = stream.audioSampleRate;
            sdpData.audioObjectType = stream.audioObjectType;
            ascInfo = stream.audioASCInfo;
            if ((ascInfo != null ? ascInfo.explicitHierarchicalSBR : void 0) && config.rtspDisableHierarchicalSBR) {
              logger.debug(("[" + TAG + ":client=" + client.id + "] converting hierarchical signaling of SBR") + (" (AudioSpecificConfig=0x" + (stream.audioSpecificConfig.toString('hex')) + ")") + " to backward compatible signaling");
              sdpData.audioSpecificConfig = new Buffer(aac.createAudioSpecificConfig(ascInfo));
            } else if (stream.audioSpecificConfig != null) {
              sdpData.audioSpecificConfig = stream.audioSpecificConfig;
            } else {
              sdpData.audioSpecificConfig = new Buffer(aac.createAudioSpecificConfig({
                audioObjectType: stream.audioObjectType,
                samplingFrequency: stream.audioSampleRate,
                channels: stream.audioChannels,
                frameLength: 1024
              }));
            }
            logger.debug("[" + TAG + ":client=" + client.id + "] sending AudioSpecificConfig: 0x" + (sdpData.audioSpecificConfig.toString('hex')));
          }
          if (stream.isVideoStarted) {
            sdpData.hasVideo = true;
            sdpData.videoPayloadType = 97;
            sdpData.videoEncodingName = 'H264';
            sdpData.videoClockRate = 90000;
            sdpData.videoProfileLevelId = stream.videoProfileLevelId;
            if (stream.spropParameterSets !== '') {
              sdpData.videoSpropParameterSets = stream.spropParameterSets;
            }
            sdpData.videoHeight = stream.videoHeight;
            sdpData.videoWidth = stream.videoWidth;
            sdpData.videoFrameRate = stream.videoFrameRate.toFixed(1);
          }
          if (stream.isRecorded()) {
            sdpData.durationSeconds = stream.durationSeconds;
          }
          try {
            body = sdp.createSDP(sdpData);
          } catch (error) {
            e = error;
            logger.error("error: Unable to create SDP: " + e);
            callback(new Error('Unable to create SDP'));
            return;
          }
          if (/^HTTP\//.test(req.protocol)) {
            res = 'HTTP/1.0 200 OK\n';
          } else {
            res = 'RTSP/1.0 200 OK\n';
          }
          if (req.headers.cseq != null) {
            res += "CSeq: " + req.headers.cseq + "\n";
          }
          dateHeader = api.getDateHeader();
          res += "Content-Base: " + req.uri + "/\nContent-Length: " + body.length + "\nContent-Type: application/sdp\nDate: " + dateHeader + "\nExpires: " + dateHeader + "\nSession: " + client.sessionID + ";timeout=60\nServer: " + _this.serverName + "\nCache-Control: no-cache\n\n";
          return callback(null, res.replace(/\n/g, "\r\n") + body);
        };
      })(this));
    };

    //This function handles the setup request
    //It specifies the client port for streaming and the server port for streaming, and the ssrc
    //This happens for each stream that the client wants by streamId.
    RTSPServer.prototype.respondSetup = function(socket, req, callback) {
      var ch1, ch2, client, controlPort, control_ch, dataPort, data_ch, dateHeader, j, len, match, media, mediaType, mode, ref, ref1, ref2, ref3, ref4, ref5, res, sdpInfo, serverPort, setupStreamId, ssrc, stream, streamId, target, track, transportHeader, useTCPTransport;
      client = this.clients[socket.clientID];
      if (!socket.isAuthenticated) {
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }
      serverPort = null;
      track = null;
      if (DEBUG_DISABLE_UDP_TRANSPORT && (!/\bTCP\b/.test(req.headers.transport))) {
        logger.info("Unsupported transport: UDP is disabled");
        this.respondWithUnsupportedTransport(callback, {
          CSeq: req.headers.cseq
        });
        return;
      }
      mode = 'play';
      if ((match = /;mode=([^;]*)/.exec(req.headers.transport)) != null) {
        mode = match[1].toUpperCase();
      }
      if (mode === 'RECORD') {
        sdpInfo = client.announceSDPInfo;
        if ((match = /\/([^\/]+)$/.exec(req.uri)) != null) {
          setupStreamId = match[1];
          mediaType = null;
          ref = sdpInfo.media;
          for (j = 0, len = ref.length; j < len; j++) {
            media = ref[j];
            if (((ref1 = media.attributes) != null ? ref1.control : void 0) === setupStreamId) {
              mediaType = media.media;
              break;
            }
          }
          if (mediaType == null) {
            throw new Error("streamid not found: " + setupStreamId);
          }
        } else {
          throw new Error("Unknown URI: " + req.uri);
        }
        streamId = RTSPServer.getStreamIdFromUri(req.uri, 1);
        stream = avstreams.get(streamId);
        if (stream == null) {
          logger.warn("warning: SETUP specified non-existent stream: " + streamId);
          logger.warn("         Stream has to be created by ANNOUNCE method.");
          stream = avstreams.create(streamId);
          stream.type = avstreams.STREAM_TYPE_LIVE;
        }
        if (stream.rtspUploadingClient == null) {
          stream.rtspUploadingClient = {};
        }
        if (stream.rtspUploadingClient.uploadingChannels == null) {
          stream.rtspUploadingClient.uploadingChannels = {};
        }
        if ((match = /;interleaved=(\d)-(\d)/.exec(req.headers.transport)) != null) {
          if (client.clientType == null) {
            client.clientType = 'publish-tcp';
            this.dumpClients();
          }
          if (mediaType === 'video') {
            stream.rtspUploadingClient.uploadingChannels.videoData = parseInt(match[1]);
            stream.rtspUploadingClient.uploadingChannels.videoControl = parseInt(match[2]);
          } else {
            stream.rtspUploadingClient.uploadingChannels.audioData = parseInt(match[1]);
            stream.rtspUploadingClient.uploadingChannels.audioControl = parseInt(match[2]);
          }
          transportHeader = req.headers.transport.replace(/mode=[^;]*/, '');
        } else {
          if (client.clientType == null) {
            client.clientType = 'publish-udp';
            this.dumpClients();
          }
          if (mediaType === 'video') {
            ref2 = [config.rtspVideoDataUDPListenPort, config.rtspVideoControlUDPListenPort], dataPort = ref2[0], controlPort = ref2[1];
            if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
              logger.debug("registering video rtspUploadingClient " + client.ip + ":" + (parseInt(match[1])));
              logger.debug("registering video rtspUploadingClient " + client.ip + ":" + (parseInt(match[2])));
              this.rtspUploadingClients[client.ip + ':' + parseInt(match[1])] = client;
              this.rtspUploadingClients[client.ip + ':' + parseInt(match[2])] = client;
            }
          } else {
            ref3 = [config.rtspAudioDataUDPListenPort, config.rtspAudioControlUDPListenPort], dataPort = ref3[0], controlPort = ref3[1];
            if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
              logger.debug("registering audio rtspUploadingClient " + client.ip + ":" + (parseInt(match[1])));
              logger.debug("registering audio rtspUploadingClient " + client.ip + ":" + (parseInt(match[2])));
              this.rtspUploadingClients[client.ip + ':' + parseInt(match[1])] = client;
              this.rtspUploadingClients[client.ip + ':' + parseInt(match[2])] = client;
            }
          }
          transportHeader = req.headers.transport.replace(/mode=[^;]*/, '') + ("server_port=" + dataPort + "-" + controlPort);
        }
        dateHeader = api.getDateHeader();
        res = ("RTSP/1.0 200 OK\nDate: " + dateHeader + "\nExpires: " + dateHeader + "\nTransport: " + transportHeader + "\nSession: " + client.sessionID + ";timeout=60\nCSeq: " + req.headers.cseq + "\nServer: " + this.serverName + "\nCache-Control: no-cache\n\n").replace(/\n/g, "\r\n");
        return callback(null, res);
      } else {
        if (/trackID=1\/?$/.test(req.uri)) {
          track = 'audio';
          if (client.useHTTP) {
            ssrc = client.getClient.audioSSRC;
          } else {
            ssrc = client.audioSSRC;
          }
          serverPort = config.audioRTPServerPort + "-" + config.audioRTCPServerPort;
          if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
            client.clientAudioRTPPort = parseInt(match[1]);
            client.clientAudioRTCPPort = parseInt(match[2]);
          }
        } else {
          track = 'video';
          if (client.useHTTP) {
            ssrc = client.getClient.videoSSRC;
          } else {
            ssrc = client.videoSSRC;
          }
          serverPort = config.videoRTPServerPort + "-" + config.videoRTCPServerPort;
          if ((match = /;client_port=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
            client.clientVideoRTPPort = parseInt(match[1]);
            client.clientVideoRTCPPort = parseInt(match[2]);
          }
        }
        if (/\bTCP\b/.test(req.headers.transport)) {
          useTCPTransport = true;
          if ((match = /;interleaved=(\d+)-(\d+)/.exec(req.headers.transport)) != null) {
            ch1 = parseInt(match[1]);
            ch2 = parseInt(match[2]);
            if (ch1 % 2 === 0) {
              ref4 = [ch1, ch2], data_ch = ref4[0], control_ch = ref4[1];
            } else {
              ref5 = [ch2, ch1], data_ch = ref5[0], control_ch = ref5[1];
            }
          } else {
            if (track === 'audio') {
              data_ch = 0;
              control_ch = 1;
            } else {
              data_ch = 2;
              control_ch = 3;
            }
          }
          if (track === 'video') {
            if (client.useHTTP) {
              target = client.getClient;
            } else {
              target = client;
            }
            target.videoTCPDataChannel = data_ch;
            target.videoTCPControlChannel = control_ch;
            target.useTCPForVideo = true;
          } else {
            if (client.useHTTP) {
              target = client.getClient;
            } else {
              target = client;
            }
            target.audioTCPDataChannel = data_ch;
            target.audioTCPControlChannel = control_ch;
            target.useTCPForAudio = true;
          }
        } else {
          useTCPTransport = false;
          if (track === 'video') {
            client.useTCPForVideo = false;
          } else {
            client.useTCPForAudio = false;
          }
        }
        client.supportsReliableRTP = req.headers['x-retransmit'] === 'our-retransmit';
        if (req.headers['x-dynamic-rate'] != null) {
          client.supportsDynamicRate = req.headers['x-dynamic-rate'] === '1';
        } else {
          client.supportsDynamicRate = client.supportsReliableRTP;
        }
        if (req.headers['x-transport-options'] != null) {
          match = /late-tolerance=([0-9.]+)/.exec(req.headers['x-transport-options']);
          if (match != null) {
            client.lateTolerance = parseFloat(match[1]);
          }
        }
        if (useTCPTransport) {
          if (/;interleaved=/.test(req.headers.transport)) {
            transportHeader = req.headers.transport;
          } else {
            transportHeader = req.headers.transport + (";interleaved=" + data_ch + "-" + control_ch) + (";ssrc=" + (zeropad(8, ssrc.toString(16))));
          }
        } else {
          transportHeader = req.headers.transport + (";server_port=" + serverPort + ";ssrc=" + (zeropad(8, ssrc.toString(16))));
        }
        dateHeader = api.getDateHeader();
        res = ("RTSP/1.0 200 OK\nDate: " + dateHeader + "\nExpires: " + dateHeader + "\nTransport: " + transportHeader + "\nSession: " + client.sessionID + ";timeout=60\nCSeq: " + req.headers.cseq + "\nServer: " + this.serverName + "\nCache-Control: no-cache\n\n").replace(/\n/g, "\r\n");
        return callback(null, res);
      }
    };

    //Once the describe and setup requests have finished, the play request starts sending
    //packets over to the client that is waiting on the expected ports.
    RTSPServer.prototype.respondPlay = function(socket, req, callback) {
      var client, doResumeLater, match, preventFromPlaying, rangeStartTime, seq, startTime, stream;
      if ((req.headers.range != null) && ((match = /npt=([\d.]+)-/.exec(req.headers.range)) != null)) {
        startTime = parseFloat(match[1]);
      } else {
        startTime = null;
      }
      client = this.clients[socket.clientID];
      if (!socket.isAuthenticated) {
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }
      preventFromPlaying = false;
      stream = client.stream;
      if (stream == null) {
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }
      doResumeLater = false;
      rangeStartTime = 0;
      seq = new Sequent;
      if (stream.isRecorded()) {
        if ((startTime == null) && stream.isPaused()) {
          startTime = stream.getCurrentPlayTime();
          logger.info("[" + TAG + ":client=" + client.id + "] resuming stream at " + (stream.getCurrentPlayTime()));
        }
        if (startTime != null) {
          logger.info("[" + TAG + ":client=" + client.id + "] seek to " + startTime);
          stream.pause();
          rangeStartTime = startTime;
          stream.seek(startTime, function(err, actualStartTime) {
            if (err) {
              logger.error("[" + TAG + ":client=" + client.id + "] error: seek failed: " + err);
              return;
            }
            logger.debug("[" + TAG + ":client=" + client.id + "] finished seeking stream to " + startTime);
            return stream.sendVideoPacketsSinceLastKeyFrame(startTime, function() {
              doResumeLater = true;
              return seq.done();
            });
          });
        } else {
          seq.done();
        }
      } else {
        seq.done();
      }
      return seq.wait(1, (function(_this) {
        return function() {
          var baseUrl, res, rtpInfos;
          baseUrl = req.uri.replace(/\/$/, '');
          rtpInfos = [];
          if (stream.isAudioStarted) {
            rtpInfos.push("url=" + baseUrl + "/trackID=1;seq=" + (_this.getNextAudioSequenceNumber(stream)) + ";rtptime=" + (_this.getNextAudioRTPTimestamp(stream)));
          }
          if (stream.isVideoStarted) {
            rtpInfos.push("url=" + baseUrl + "/trackID=2;seq=" + (_this.getNextVideoSequenceNumber(stream)) + ";rtptime=" + (_this.getNextVideoRTPTimestamp(stream)));
          }
          res = ("RTSP/1.0 200 OK\nRange: npt=" + rangeStartTime + "-\nSession: " + client.sessionID + ";timeout=60\nCSeq: " + req.headers.cseq + "\nRTP-Info: " + (rtpInfos.join(',')) + "\nServer: " + _this.serverName + "\nCache-Control: no-cache\n\n").replace(/\n/g, "\r\n");
          if (!preventFromPlaying) {
            stream.rtspNumClients++;
            client.enablePlaying();
            if (client.useHTTP) {
              logger.info("[" + TAG + ":client=" + client.getClient.id + "] start streaming over HTTP GET");
              stream.rtspClients[client.getClient.id] = client.getClient;
              client.clientType = 'http-post';
              client.getClient.clientType = 'http-get';
              _this.dumpClients();
            } else if (client.useTCPForVideo) {
              logger.info("[" + TAG + ":client=" + client.id + "] start streaming over TCP");
              stream.rtspClients[client.id] = client;
              client.clientType = 'tcp';
              _this.dumpClients();
            } else {
              logger.info("[" + TAG + ":client=" + client.id + "] start streaming over UDP");
              if (ENABLE_START_PLAYING_FROM_KEYFRAME && stream.isVideoStarted) {
                client.isWaitingForKeyFrame = true;
              } else {
                client.isPlaying = true;
              }
              stream.rtspClients[client.id] = client;
              client.clientType = 'udp';
              _this.dumpClients();
            }
            if (client.useHTTP) {
              _this.startSendingRTCP(stream, client.getClient);
            } else {
              _this.startSendingRTCP(stream, client);
            }
          } else {
            logger.info("[" + TAG + ":client=" + client.id + "] not playing");
          }
          callback(null, res);
          if (doResumeLater) {
            return stream.resume(false);
          }
        };
      })(this));
    };

    //For the pause request, the server responds affirmatively
    //and sets a timeout if there is a range. If there is no range
    //then the pause will be indefinite
    RTSPServer.prototype.respondPause = function(socket, req, callback) {
      var client, res;
      client = this.clients[socket.clientID];
      if (!socket.isAuthenticated) {
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }
      this.stopSendingRTCP(client);
      client.disablePlaying();
      if (client.stream.isRecorded()) {
        client.stream.pause();
      }
      res = ("RTSP/1.0 200 OK\nSession: " + client.sessionID + ";timeout=60\nCSeq: " + req.headers.cseq + "\nCache-Control: no-cache\n\n").replace(/\n/g, "\r\n");
      return callback(null, res);
    };

    RTSPServer.prototype.respondTeardown = function(socket, req, callback) {
      var client, ref, res, stream;
      client = this.clients[socket.clientID];
      stream = (ref = client.uploadingStream) != null ? ref : client.stream;
      if (client === (stream != null ? stream.rtspUploadingClient : void 0)) {
        logger.info("[" + TAG + ":client=" + client.id + "] finished uploading stream " + stream.id);
        stream.rtspUploadingClient = null;
        stream.emit('end');
      }
      if ((stream != null ? stream.type : void 0) === avstreams.STREAM_TYPE_RECORDED) {
        if (typeof stream.teardown === "function") {
          stream.teardown();
        }
      }
      if (!socket.isAuthenticated) {
        this.respondWithNotFound(req, 'RTSP', callback);
        return;
      }
      client.disablePlaying();
      if ((stream != null ? stream.rtspClients[client.id] : void 0) != null) {
        delete stream.rtspClients[client.id];
        stream.rtspNumClients--;
      }
      res = ("RTSP/1.0 200 OK\nSession: " + client.sessionID + ";timeout=60\nCSeq: " + req.headers.cseq + "\nCache-Control: no-cache\n\n").replace(/\n/g, "\r\n");
      return callback(null, res);
    };

    //The announce request tells the server where to expect the data to be streamed 
    //to. The server gets the streamId it has assigned to the client, and checks if
    //the parameters of the stream and the format is acceptable. If it is not, the server
    //will not accept the connection, and no recording will happen.
    RTSPServer.prototype.respondAnnounce = function(socket, req, callback) {
      var ascInfo, audioObjectType, audioSpecificConfig, client, j, k, len, len1, media, nalUnit, nalUnitType, nalUnits, packetizationMode, ref, ref1, ref2, res, sdpInfo, stream, streamId;
      client = this.clients[socket.clientID];
      streamId = RTSPServer.getStreamIdFromUri(req.uri);
      stream = avstreams.get(streamId);
      if (stream != null) {
        stream.reset();
        this.rtpParser.clearUnorderedPacketBuffer(stream.id);
      } else {
        stream = avstreams.create(streamId);
        stream.type = avstreams.STREAM_TYPE_LIVE;
      }
      sdpInfo = sdp.parse(req.body);
      ref = sdpInfo.media;
      for (j = 0, len = ref.length; j < len; j++) {
        media = ref[j];
        if (media.media === 'video') {
          sdpInfo.video = media;
          if (((ref1 = media.fmtpParams) != null ? ref1['packetization-mode'] : void 0) != null) {
            packetizationMode = parseInt(media.fmtpParams['packetization-mode']);
            if (packetizationMode !== 0 && packetizationMode !== 1) {
              logger.error("[rtsp:stream:" + streamId + "] error: unsupported packetization-mode: " + packetizationMode);
            }
          }
          if (((ref2 = media.fmtpParams) != null ? ref2['sprop-parameter-sets'] : void 0) != null) {
            nalUnits = h264.parseSpropParameterSets(media.fmtpParams['sprop-parameter-sets']);
            for (k = 0, len1 = nalUnits.length; k < len1; k++) {
              nalUnit = nalUnits[k];
              nalUnitType = nalUnit[0] & 0x1f;
              switch (nalUnitType) {
                case h264.NAL_UNIT_TYPE_SPS:
                  stream.updateSPS(nalUnit);
                  break;
                case h264.NAL_UNIT_TYPE_PPS:
                  stream.updatePPS(nalUnit);
                  break;
                default:
                  logger.warn("unknown nal_unit_type " + nalUnitType + " in sprop-parameter-sets");
              }
            }
          }
        } else if (media.media === 'audio') {
          sdpInfo.audio = media;
          if (media.clockRate == null) {
            logger.error("Error: rtpmap attribute in SDP must have audio clock rate; assuming 44100");
            media.clockRate = 44100;
          }
          if (media.audioChannels == null) {
            logger.error("Error: rtpmap attribute in SDP must have audio channels; assuming 2");
            media.audioChannels = 2;
          }
          logger.debug("[" + TAG + ":client=" + client.id + "] audio fmtp: " + (JSON.stringify(media.fmtpParams)));
          if (media.fmtpParams == null) {
            logger.error("Error: fmtp attribute does not exist in SDP");
            media.fmtpParams = {};
          }
          audioSpecificConfig = null;
          ascInfo = null;
          if ((media.fmtpParams.config != null) && (media.fmtpParams.config !== '')) {
            audioSpecificConfig = new Buffer(media.fmtpParams.config, 'hex');
            ascInfo = aac.parseAudioSpecificConfig(audioSpecificConfig);
            audioObjectType = ascInfo.audioObjectType;
          } else {
            logger.error("Error: fmtp attribute in SDP does not have config parameter; assuming audioObjectType=2");
            audioObjectType = 2;
          }
          stream.updateConfig({
            audioSampleRate: media.clockRate,
            audioClockRate: media.clockRate,
            audioChannels: media.audioChannels,
            audioObjectType: audioObjectType,
            audioSpecificConfig: audioSpecificConfig,
            audioASCInfo: ascInfo
          });
          if (media.fmtpParams.sizelength != null) {
            media.fmtpParams.sizelength = parseInt(media.fmtpParams.sizelength);
          } else {
            logger.error("Error: fmtp attribute in SDP must have sizelength parameter; assuming 13");
            media.fmtpParams.sizelength = 13;
          }
          if (media.fmtpParams.indexlength != null) {
            media.fmtpParams.indexlength = parseInt(media.fmtpParams.indexlength);
          } else {
            logger.error("Error: fmtp attribute in SDP must have indexlength parameter; assuming 3");
            media.fmtpParams.indexlength = 3;
          }
          if (media.fmtpParams.indexdeltalength != null) {
            media.fmtpParams.indexdeltalength = parseInt(media.fmtpParams.indexdeltalength);
          } else {
            logger.error("Error: fmtp attribute in SDP must have indexdeltalength parameter; assuming 3");
            media.fmtpParams.indexdeltalength = 3;
          }
        }
      }
      client.announceSDPInfo = sdpInfo;
      stream.rtspUploadingClient = client;
      client.uploadingStream = stream;
      client.uploadingTimestampInfo = {};
      socket.isAuthenticated = true;
      res = ("RTSP/1.0 200 OK\nCSeq: " + req.headers.cseq + "\n\n").replace(/\n/g, "\r\n");
      return callback(null, res);
    };

    //If the client object has been initialized correctly by a successful announce request,
    //then the server triggers the events associated with video_start and audio_start, which
    //we saw reset the Framerate and start the video/audio instantly (calling functions
    // onReceiveVideoControlBuffer, onReceiveAudioControlBuffer in stream_server.js).
    RTSPServer.prototype.respondRecord = function(socket, req, callback) {
      var client, res, stream, streamId;
      client = this.clients[socket.clientID];
      streamId = RTSPServer.getStreamIdFromUri(req.uri);
      logger.info("[" + TAG + ":client=" + client.id + "] started uploading stream " + streamId);
      stream = avstreams.getOrCreate(streamId);
      if (client.announceSDPInfo.video != null) {
        this.emit('video_start', stream);
      }
      if (client.announceSDPInfo.audio != null) {
        this.emit('audio_start', stream);
      }
      res = ("RTSP/1.0 200 OK\nSession: " + client.sessionID + ";timeout=60\nCSeq: " + req.headers.cseq + "\nServer: " + this.serverName + "\nCache-Control: no-cache\n\n").replace(/\n/g, "\r\n");
      return callback(null, res);
    };

    //This function parses the request and calls the appropriate callback from the ones we saw above
    RTSPServer.prototype.respond = function(socket, req, callback) {
      if ((req.protocolName !== 'RTSP') && (req.protocolName !== 'HTTP')) {
        callback(null, null, {
          close: true
        });
      }
      if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'OPTIONS')) {
        return this.respondOptions(socket, req, callback);
      } else if ((req.method === 'POST') && (req.protocolName === 'HTTP')) {
        return this.respondPost(socket, req, callback);
      } else if ((req.method === 'GET') && (req.protocolName === 'HTTP')) {
        return this.respondGet(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'DESCRIBE')) {
        return this.respondDescribe(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'SETUP')) {
        return this.respondSetup(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'PLAY')) {
        return this.respondPlay(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'PAUSE')) {
        return this.respondPause(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'TEARDOWN')) {
        return this.respondTeardown(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'ANNOUNCE')) {
        return this.respondAnnounce(socket, req, callback);
      } else if (config.enableRTSP && (req.protocolName === 'RTSP') && (req.method === 'RECORD')) {
        return this.respondRecord(socket, req, callback);
      } else {
        logger.warn("[" + TAG + "] method \"" + req.method + "\" not implemented for protocol \"" + req.protocol + "\"");
        return this.respondWithNotFound(req, req.protocolName, callback);
      }
    };

    RTSPServer.prototype.onUploadVideoData = function(stream, msg, rinfo) {
      var packet;
      if (stream.rtspUploadingClient == null) {
        return;
      }
      packet = rtp.parsePacket(msg);
      if (stream.rtspUploadingClient.videoRTPStartTimestamp == null) {
        stream.rtspUploadingClient.videoRTPStartTimestamp = packet.rtpHeader.timestamp;
      }
      if (packet.rtpHeader.payloadType === stream.rtspUploadingClient.announceSDPInfo.video.fmt) {
        return this.rtpParser.feedUnorderedH264Buffer(msg, stream.id);
      } else {
        return logger.error("Error: Unknown payload type: " + packet.rtpHeader.payloadType + " as video");
      }
    };

    RTSPServer.prototype.onUploadVideoControl = function(stream, msg, rinfo) {
      var j, len, packet, packets, results;
      if (stream.rtspUploadingClient == null) {
        return;
      }
      packets = rtp.parsePackets(msg);
      results = [];
      for (j = 0, len = packets.length; j < len; j++) {
        packet = packets[j];
        if (packet.rtcpSenderReport != null) {
          if (stream.rtspUploadingClient.uploadingTimestampInfo.video == null) {
            stream.rtspUploadingClient.uploadingTimestampInfo.video = {};
          }
          stream.rtspUploadingClient.uploadingTimestampInfo.video.rtpTimestamp = packet.rtcpSenderReport.rtpTimestamp;
          results.push(stream.rtspUploadingClient.uploadingTimestampInfo.video.time = packet.rtcpSenderReport.ntpTimestampInMs);
        } else {
          results.push(void 0);
        }
      }
      return results;
    };

    RTSPServer.prototype.onUploadAudioData = function(stream, msg, rinfo) {
      var packet;
      if (stream.rtspUploadingClient == null) {
        return;
      }
      packet = rtp.parsePacket(msg);
      if (stream.rtspUploadingClient.audioRTPStartTimestamp == null) {
        stream.rtspUploadingClient.audioRTPStartTimestamp = packet.rtpHeader.timestamp;
      }
      if (packet.rtpHeader.payloadType === stream.rtspUploadingClient.announceSDPInfo.audio.fmt) {
        return this.rtpParser.feedUnorderedAACBuffer(msg, stream.id, stream.rtspUploadingClient.announceSDPInfo.audio.fmtpParams);
      } else {
        return logger.error("Error: Unknown payload type: " + packet.rtpHeader.payloadType + " as audio");
      }
    };

    RTSPServer.prototype.onUploadAudioControl = function(stream, msg, rinfo) {
      var j, len, packet, packets, results;
      if (stream.rtspUploadingClient == null) {
        return;
      }
      packets = rtp.parsePackets(msg);
      results = [];
      for (j = 0, len = packets.length; j < len; j++) {
        packet = packets[j];
        if (packet.rtcpSenderReport != null) {
          if (stream.rtspUploadingClient.uploadingTimestampInfo.audio == null) {
            stream.rtspUploadingClient.uploadingTimestampInfo.audio = {};
          }
          stream.rtspUploadingClient.uploadingTimestampInfo.audio.rtpTimestamp = packet.rtcpSenderReport.rtpTimestamp;
          results.push(stream.rtspUploadingClient.uploadingTimestampInfo.audio.time = packet.rtcpSenderReport.ntpTimestampInMs);
        } else {
          results.push(void 0);
        }
      }
      return results;
    };

    return RTSPServer;

  })();


  //This is the client object, with the functions
  //for disabling and enabling playing attached.
  RTSPClient = (function() {
    function RTSPClient(opts) {
      var name, value;
      this.videoPacketCount = 0;
      this.videoOctetCount = 0;
      this.audioPacketCount = 0;
      this.audioOctetCount = 0;
      this.isPlaying = false;
      this.timeoutID = null;
      this.videoSSRC = generateRandom32();
      this.audioSSRC = generateRandom32();
      this.supportsReliableRTP = false;
      for (name in opts) {
        value = opts[name];
        this[name] = value;
      }
    }

    RTSPClient.prototype.disablePlaying = function() {
      if (this.useHTTP) {
        this.getClient.isWaitingForKeyFrame = false;
        return this.getClient.isPlaying = false;
      } else {
        this.isWaitingForKeyFrame = false;
        return this.isPlaying = false;
      }
    };

    RTSPClient.prototype.enablePlaying = function() {
      if (this.useHTTP) {
        if (ENABLE_START_PLAYING_FROM_KEYFRAME && client.stream.isVideoStarted) {
          return this.getClient.isWaitingForKeyFrame = true;
        } else {
          return this.getClient.isPlaying = true;
        }
      } else {
        if (ENABLE_START_PLAYING_FROM_KEYFRAME && stream.isVideoStarted) {
          return this.isWaitingForKeyFrame = true;
        } else {
          return this.isPlaying = true;
        }
      }
    };

    RTSPClient.prototype.toString = function() {
      var ref, transportDesc;
      if (this.socket.remoteAddress == null) {
        return this.id + ": session=" + this.sessionID + " (being destroyed)";
      } else {
        transportDesc = this.clientType != null ? "type=" + this.clientType : '';
        if ((ref = this.clientType) === 'http-get' || ref === 'tcp' || ref === 'udp') {
          transportDesc += " isPlaying=" + this.isPlaying;
        }
        return this.id + ": session=" + this.sessionID + " addr=" + this.socket.remoteAddress + " port=" + this.socket.remotePort + " " + transportDesc;
      }
    };

    return RTSPClient;

  })();

  //This api parses/creates interleaved headers
  api = {
    RTSPServer: RTSPServer,
    INTERLEAVED_SIGN: 0x24,
    INTERLEAVED_HEADER_LEN: 4,
    createInterleavedHeader: function(opts) {
      if ((opts != null ? opts.channel : void 0) == null) {
        throw new Error("createInterleavedHeader: channel is required");
      }
      if ((opts != null ? opts.payloadLength : void 0) == null) {
        throw new Error("createInterleavedHeader: payloadLength is required");
      }
      return new Buffer([api.INTERLEAVED_SIGN, opts.channel, opts.payloadLength >> 8, opts.payloadLength & 0xff]);
    },
    parseInterleavedHeader: function(buf) {
      var info;
      if (buf.length < api.INTERLEAVED_HEADER_LEN) {
        return null;
      }
      if (buf[0] !== api.INTERLEAVED_SIGN) {
        throw new Error("The buffer is not an interleaved data");
      }
      info = {};
      info.channel = buf[1];
      info.payloadLength = (buf[2] << 8) | buf[3];
      info.totalLength = api.INTERLEAVED_HEADER_LEN + info.payloadLength;
      return info;
    },
    getInterleavedData: function(buf) {
      var info;
      info = api.parseInterleavedHeader(buf);
      if (info == null) {
        return null;
      }
      if (buf.length < info.totalLength) {
        return null;
      }
      info.data = buf.slice(api.INTERLEAVED_HEADER_LEN, info.totalLength);
      return info;
    },
    isLoopbackAddress: function(socket) {
      return socket.remoteAddress === '127.0.0.1';
    },
    isPrivateNetwork: function(socket) {
      var match, num;
      if (/^(10\.|192\.168\.|127\.0\.0\.)/.test(socket.remoteAddress)) {
        return true;
      }
      if ((match = /^172.(\d+)\./.exec(socket.remoteAddress)) != null) {
        num = parseInt(match[1]);
        if ((16 <= num && num <= 31)) {
          return true;
        }
      }
      return false;
    },
    getDateHeader: function() {
      var d;
      d = new Date;
      return (DAY_NAMES[d.getUTCDay()] + ", " + (d.getUTCDate()) + " " + MONTH_NAMES[d.getUTCMonth()]) + (" " + (d.getUTCFullYear()) + " " + (zeropad(2, d.getUTCHours())) + ":" + (zeropad(2, d.getUTCMinutes()))) + (":" + (zeropad(2, d.getUTCSeconds())) + " UTC");
    },
    getLocalIP: function() {
      var addr, getPriority, ifaceName, ifaceNames, ifacePrecedence, ifaces, j, k, len, len1, ref;
      ifacePrecedence = ['wlan', 'eth', 'en'];
      getPriority = function(ifaceName) {
        var i, j, len, name;
        for (i = j = 0, len = ifacePrecedence.length; j < len; i = ++j) {
          name = ifacePrecedence[i];
          if (ifaceName.indexOf(name) === 0) {
            return i;
          }
        }
        return ifacePrecedence.length;
      };
      ifaces = os.networkInterfaces();
      ifaceNames = Object.keys(ifaces);
      ifaceNames.sort(function(a, b) {
        return getPriority(a) - getPriority(b);
      });
      for (j = 0, len = ifaceNames.length; j < len; j++) {
        ifaceName = ifaceNames[j];
        ref = ifaces[ifaceName];
        for (k = 0, len1 = ref.length; k < len1; k++) {
          addr = ref[k];
          if ((!addr.internal) && (addr.family === 'IPv4')) {
            return addr.address;
          }
        }
      }
      return "127.0.0.1";
    },
    getExternalIP: function() {
      return "127.0.0.1";
    },
    getMeaningfulIPTo: function(socket) {
      if (api.isLoopbackAddress(socket)) {
        return '127.0.0.1';
      } else if (api.isPrivateNetwork(socket)) {
        return api.getLocalIP();
      } else {
        return api.getExternalIP();
      }
    },
    leaveClient: function(client) {
      var ref, stream, streamName;
      ref = avstreams.getAll();
      for (streamName in ref) {
        stream = ref[streamName];
        logger.debug("[stream:" + stream.id + "] leaveClient: " + client.id);
        if (stream.rtspClients[client.id] != null) {
          delete stream.rtspClients[client.id];
          stream.rtspNumClients--;
        }
      }
    }
  };

  module.exports = api;

}).call(this);
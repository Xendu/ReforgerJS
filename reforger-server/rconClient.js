const dgram = require('dgram');
const crc32 = require('buffer-crc32');

class BattleEyeClientReforger {
  /**
   * @param {string} ip - IP of the server
   * @param {number} port - Game (UDP) port
   * @param {string} password - RCon password
   */
  constructor(ip, port, password) {
    this.socket = dgram.createSocket('udp4');
    this.ip = ip;
    this.port = port;
    this.password = password;

    // Optional: external handlers
    this.messageHandler = null; 
    this.timeoutHandler = null;
    this.loginSuccessHandler = null;

    this.sequenceNumber = 0;
    this.loggedIn = false;
    this.lastResponse = 0;
    this.error = false; 
    this.interval = null; 
    this.multipacket = null; 

    // We'll use one watchdog timer for timeouts / inactivity
    this.watchdog = null;
  }

  /**
   * Opens the socket, attempts to login, and sets up event listeners.
   */
  connect() {
    this.socket.bind();

    // Handle socket errors
    this.socket.on('error', (err) => {
      console.log('Socket error:', err);
      this.error = true;
      // Optionally close:
      this.close();
    });

    // Handle incoming packets
    this.socket.on('message', (message) => {
      // 'message' is a Buffer
      this.lastResponse = Date.now();
      this.resetWatchdog();

      if (message.length < 8) {
        console.warn('Received malformed packet (too short).');
        return;
      }

      const packetType = message[7];

      switch (packetType) {
        /**
         * 1) Login response: 0x00
         *    0x00 | (0x01 if success, 0x00 if fail)
         */
        case 0x00: {
          if (message.length < 9) {
            console.warn('Malformed login response (too short).');
            return;
          }
          const loginResp = message[8];
          if (loginResp === 0x01) {
            this.loggedIn = true;
            if (this.loginSuccessHandler) {
              this.loginSuccessHandler();
            }
          } else if (loginResp === 0x00) {
            console.log('Login failed');
            this.close();
            this.error = true;
          } else {
            console.log('Unknown login response');
            this.error = true;
          }
          return;
        }

        /**
         * 2) Command packet response or multi-packet response: 0x01
         *
         * The server's response to a command has the format:
         *   0x01 | echoed 1-byte sequence number | optional data
         *
         * If the response is too large, the server splits it into multiple packets:
         *   0x01 | echoed 1-byte seq num | 0x00 | #packets | index | data
         */
        case 0x01: {
          if (message.length < 9) {
            console.warn('Malformed command response (too short).');
            return;
          }

          const seq = message[8]; // The echoed sequence number

          // Check if it's a multi-packet response (bytes 9,10 are 0x00, #packets)
          if (message.length >= 12 && message[9] === 0x00) {
            const totalPackets = message[10];
            const currentIndex = message[11];

            // If this is the first packet, create an array to store all parts
            if (currentIndex === 0) {
              this.multipacket = new Array(totalPackets);
            }

            // Store if indexes match
            if (this.multipacket && this.multipacket.length === totalPackets) {
              this.multipacket[currentIndex] = this.stripHeaderMultipacket(message);
            }

            // If this was the last piece
            if (currentIndex + 1 === totalPackets) {
              let combined = '';
              for (let i = 0; i < this.multipacket.length; i++) {
                combined += this.multipacket[i].toString();
              }
              if (this.messageHandler) {
                this.messageHandler(combined);
              }
              this.multipacket = null;
            }
          } else {
            // Single packet response
            if (this.messageHandler) {
              const msg = this.stripHeaderCommandResponse(message).toString();
              this.messageHandler(msg);
            }
          }
          return;
        }

        /**
         * 3) Server message: 0x02
         *    0x02 | 1-byte seq number | server message
         * The client must acknowledge with 0x02 | that same seq number.
         * If not acknowledged, the server will eventually deauthenticate us.
         */
        case 0x02: {
          if (message.length < 9) {
            console.warn('Malformed server message (too short).');
            return;
          }
          const seq = message[8];
          this.acknowledgeServerMessage(seq);

          // The rest is the server message
          if (this.messageHandler) {
            const msg = this.stripHeaderServerMessage(message).toString();
            this.messageHandler(msg);
          }
          return;
        }

        default:
          console.warn(`Unknown packet type: 0x${packetType.toString(16)}`);
      }
    });

    // Send login
    this.login();

    // Keep-alive ping every 30 seconds (must be <= 45 seconds per spec)
    this.interval = setInterval(() => {
      this.keepAlive();
    }, 30000);
  }

  /**
   * The spec requires sending an empty command packet at least every 45 seconds
   * to keep the connection alive if no other commands are sent.
   */
  keepAlive() {
    if (!this.loggedIn || this.error) return;
    const seq = this.sequenceNumber & 0xff;
    this.sequenceNumber++;

    const keepaliveBuf = Buffer.alloc(2);
    keepaliveBuf[0] = 0x01; // command type
    keepaliveBuf[1] = seq;  // sequence

    const packet = this.buildPacket(keepaliveBuf);
    this.send(packet);
  }

  /**
   * Attempt login by sending:
   *   0x00 | password
   */
  login() {
    const loginBuf = Buffer.alloc(this.password.length + 1);
    loginBuf[0] = 0x00; // login type
    for (let i = 0; i < this.password.length; i++) {
      loginBuf[i + 1] = this.password.charCodeAt(i);
    }

    const packet = this.buildPacket(loginBuf);
    this.send(packet);
    this.resetWatchdog();
  }

  /**
   * Send a command packet:
   *   0x01 | sequence number | ASCII command
   */
  sendCommand(command) {
    if (!this.loggedIn || this.error) {
      console.warn('Cannot send command: not logged in or error state.');
      return;
    }
    const seq = this.sequenceNumber & 0xff;
    this.sequenceNumber++;

    // Create buffer: type(1 byte) + seq(1 byte) + command
    const cmdBuffer = Buffer.alloc(2 + command.length);
    cmdBuffer[0] = 0x01; // command type
    cmdBuffer[1] = seq;  // sequence
    for (let i = 0; i < command.length; i++) {
      cmdBuffer[i + 2] = command.charCodeAt(i);
    }

    const packet = this.buildPacket(cmdBuffer);
    this.send(packet);
    this.resetWatchdog();
  }

  /**
   * Acknowledge a server message (type 0x02).
   * The doc: "The client has to acknowledge with 0x02 | received seq number."
   */
  acknowledgeServerMessage(sequenceNumber) {
    const ackBuffer = Buffer.alloc(2);
    ackBuffer[0] = 0x02;  // ack type
    ackBuffer[1] = sequenceNumber;
    const packet = this.buildPacket(ackBuffer);
    this.send(packet);
  }

  /**
   * Build a complete RCon packet:
   *    2 bytes:   'B'(0x42), 'E'(0x45)
   *    4 bytes:   CRC32 of all subsequent payload bytes (including 0xFF)
   *    1 byte:    0xFF
   *    N bytes:   actual RCon payload (type + data)
   */
  buildPacket(payload) {

    const nBuffer = Buffer.alloc(1 + payload.length);
    nBuffer[0] = 0xFF;
    payload.copy(nBuffer, 1);

    // CRC32 of nBuffer
    const crc = crc32(nBuffer); // typically a 4-byte Buffer

    // Build final buffer
    const packet = Buffer.alloc(7 + payload.length);
    // 'B'(0x42), 'E'(0x45)
    packet[0] = 0x42;
    packet[1] = 0x45;
    // CRC (4 bytes) in standard order
    packet[2] = crc[0];
    packet[3] = crc[1];
    packet[4] = crc[2];
    packet[5] = crc[3];
    // 0xFF
    packet[6] = 0xFF;
    // Copy payload
    payload.copy(packet, 7);

    return packet;
  }

  /**
   * Sends the data over the socket. If we're in an error state, does nothing.
   */
  send(data) {
    if (this.error) return;
    this.socket.send(data, 0, data.length, this.port, this.ip);
  }

  /**
   * Reset (or start) the single watchdog timer.
   * If no new packet arrives in 60 seconds, we close.
   * (Adjust as needed for your environment.)
   */
  resetWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
    }
    // Increase to 60s or more
    this.watchdog = setTimeout(() => {
      if (Date.now() - this.lastResponse >= 60000) {
        console.warn('Connection timed out - no response from server in 60s.');
        this.close();
      }
    }, 60000);
  }

  /**
   * Strips the 0x01, seq, and possible multi-packet header from a command response.
   * Typically we remove 9 bytes from the front: the 7-byte global header,
   * plus 2 more (0x01 type and seq).
   */
  stripHeaderCommandResponse(buf) {
    if (buf.length <= 9) return Buffer.alloc(0);
    return buf.slice(9);
  }

  /**
   * Strips 7-byte global header + 1 byte type (0x02) + 1 byte seq = 9 bytes total
   */
  stripHeaderServerMessage(buf) {
    if (buf.length <= 9) return Buffer.alloc(0);
    return buf.slice(9);
  }

  stripHeaderMultipacket(buf) {
    if (buf.length <= 12) return Buffer.alloc(0);
    return buf.slice(12);
  }

  /**
   * Clears intervals/timers and closes the socket gracefully.
   */
  close() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (!this.socket) return;

    this.socket.close();
    this.socket.unref();

    if (this.timeoutHandler) {
      this.timeoutHandler();
    }
  }
}

module.exports = BattleEyeClientReforger;

const fs = require('fs');
const path = require('path');

class TailLogReader {
  constructor(queueLine, options = {}) {
    if (!options.logDir) {
      throw new Error('logDir must be specified in options.');
    }
    if (typeof queueLine !== 'function') {
      throw new Error('queueLine must be specified and be a function.');
    }
    this.queueLine = queueLine;
    this.options = options;
    this.logDir = options.logDir;
    this.filename = options.filename || 'console.log';
    this.scanInterval = options.scanInterval || 3000;
    this.stateSaveInterval = options.stateSaveInterval || 60000;
    this.stateFile = options.stateFile || path.resolve(__dirname, 'logparser_state.json');
    this.currentLogPath = null;
    this.lastFileSize = 0;
    this.scanIntervalID = null;
    this.stateSaveID = null;
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.currentLogPath = state.currentLogPath || null;
        this.lastFileSize = state.lastFileSize || 0;
      }
    } catch (error) {
      console.error(`Error loading state: ${error.message}`);
    }
  }

  saveState() {
    try {
      const state = {
        currentLogPath: this.currentLogPath,
        lastFileSize: this.lastFileSize,
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      console.error(`Error saving state: ${error.message}`);
    }
  }

  findLatestLogFile() {
    try {
      // Look for subdirectories starting with 'logs_'
      const entries = fs.readdirSync(this.logDir, { withFileTypes: true });
      const dirs = entries
        .filter(entry => entry.isDirectory() && entry.name.startsWith('logs_'))
        .map(entry => entry.name)
        .sort();
      if (dirs.length) {
        const latestDir = dirs[dirs.length - 1];
        const potentialPath = path.join(this.logDir, latestDir, this.filename);
        if (fs.existsSync(potentialPath)) {
          if (this.currentLogPath !== potentialPath) {
            this.currentLogPath = potentialPath;
            this.lastFileSize = 0; // reset if log file changed
          }
          return;
        } else {
          console.warn(`Log file not found in latest directory: ${potentialPath}`);
        }
      } else {
        // Fallback: try using logDir/filename directly
        const directPath = path.join(this.logDir, this.filename);
        if (fs.existsSync(directPath)) {
          if (this.currentLogPath !== directPath) {
            this.currentLogPath = directPath;
            this.lastFileSize = 0;
          }
          return;
        }
        console.warn(`No log subdirectories found and ${directPath} does not exist.`);
      }
    } catch (err) {
      console.error(`Error finding latest log file: ${err.message}`);
    }
  }

  scanLogs() {
    if (!this.currentLogPath) {
      console.warn('No log file currently set to scan.');
      return;
    }
    try {
      const stats = fs.statSync(this.currentLogPath);
      const newSize = stats.size;
      if (newSize > this.lastFileSize) {
        const stream = fs.createReadStream(this.currentLogPath, {
          start: this.lastFileSize,
          end: newSize - 1,
        });
        let data = '';
        stream.on('data', chunk => {
          data += chunk.toString();
        });
        stream.on('end', () => {
          const lines = data.split(/\r?\n/);
          lines.forEach(line => {
            if (line.trim().length > 0) {
              this.queueLine(line);
            }
          });
          this.lastFileSize = newSize;
          stream.destroy();
        });
        stream.on('error', err => {
          console.error(`Error reading log file: ${err.message}`);
          stream.destroy();
        });
      }
    } catch (err) {
      console.error(`Error scanning logs: ${err.message}`);
    }
  }

  watch() {
    // Load saved state (if any)
    this.loadState();
    // Identify the current log file
    this.findLatestLogFile();
    if (!this.currentLogPath) {
      console.error('No log file found to monitor.');
      return Promise.reject(new Error('No log file found to monitor.'));
    }
    // Start periodic scanning
    this.scanIntervalID = setInterval(() => {
      // Re-check for log file rotation
      this.findLatestLogFile();
      this.scanLogs();
    }, this.scanInterval);

    // Periodically save state
    this.stateSaveID = setInterval(() => {
      this.saveState();
    }, this.stateSaveInterval);

    console.log(`Started watching log file: ${this.currentLogPath}`);
    return Promise.resolve();
  }

  async unwatch() {
    if (this.scanIntervalID) {
      clearInterval(this.scanIntervalID);
      this.scanIntervalID = null;
    }
    if (this.stateSaveID) {
      clearInterval(this.stateSaveID);
      this.stateSaveID = null;
    }
    this.saveState();
    return Promise.resolve();
  }
}

module.exports = TailLogReader;

var events = require('events'),
	net = require('net'),
	//kiwi = require('kiwi'),
	sys = require('sys'),
	Buffer = require("buffer").Buffer;

/**
* yaml wrapper, because yaml doesn't like beanstalk
*/
var yaml = new function() {
	this.eval = function(str) {
		// YAML sucks, reg exp to make it working(ish)
		var corrected = str.replace(/\n-\ ([\w\d_-]+)/mig, '\n  - \'$1\'') //indent list
							.replace(/(\w)\-(\w)/mgi, '$1_$2') // replace minuses in hash names
							.replace(/\n([\w\d_-]+)\:\ ([\.\,\w\d_-]+)/mig, '\n  $1: \'$2\''); // format hashes
		try {
			return kiwi.require('yaml').eval(corrected);
		} catch(e) {
			Debug.log(e);
			Debug.log(corrected);
			return str;
		}
	};
};	

/**
* Simple debug console
*/
var Debug = new function() {
	var active = false;
	
	this.log = function(str) {
		if(active) {
			sys.puts(str);
		}
	};
	
	this.activate = function() {
		active = true;
	};
};

/**
* Beanstalk job
*/
var BeanstalkJob = {};
BeanstalkJob.create = function(data) {
	if(data.length == 2) {
		return {
			id : data[0],
			data : data[1]
		};
	}
	return false;
};


/**
* Beanstalk command
*/
function BeanstalkCommand() {
	events.EventEmitter.call(this);
};
sys.inherits(BeanstalkCommand, events.EventEmitter);

BeanstalkCommand.prototype.onSuccess = function(callback) {
	this.addListener('command_done', function(data) {
		callback(data);
	});
};

BeanstalkCommand.prototype.responseHandler = function(data, obj, callback) {

	Debug.log("responseHandler - " + sys.inspect(data) + " / " + sys.inspect(obj));
	
	var lines = data.toString().split('\r\n');
	var chunks = lines[0].split(' ');
	
	if(obj.expected != chunks[0]) {
		this.emit('command_done', chunks);
		return false;
	}
	
	
	
	if(obj.is_yaml) {
		this.emit('command_done', yaml.eval(lines[1]));
	} else {
		if(chunks.length > 1) {
			chunks.shift();

			if(lines[1]) {
				chunks.pop();
				chunks.push(lines[1]);
				
				chunks = BeanstalkJob.create(chunks);
			}
		}
		
		this.emit('command_done', chunks);
	}
	
	return true;
};

/**
* Beanstalk client
*/
function BeanstalkClient() {
	events.EventEmitter.call(this);

	this.address = '127.0.0.1';
	this.port = 11300;
	this.conn;
	this.default_priority = 10;
};
sys.inherits(BeanstalkClient, events.EventEmitter);

BeanstalkClient.prototype.Instance = function(server) {
	var p = [];
	
	if(server) {
		p = server.split(':');
    }
	
	this.address = (p[0]) ? p[0] : this.address;
	this.port = (p[1]) ? p[1] : this.port;
	return this;
};

BeanstalkClient.prototype.command = function(obj) {
	var _self = this;
	var cmd = new BeanstalkCommand();
	cmd.addListener('data', cmd.responseHandler);

	this.pendingResponseBuffer = false;
	this.currentPendingResponseBufferPosition = 0;
	
	var dataHandler = function(data) {
		Debug.log('response:');
		Debug.log(data);
		
		// whacky hacky starts here  -------------------------------------------------------------
		var testBuff = new Buffer(32);
		
		data.copy(testBuff, 0, 0, data.length > 32 ? 32 : data.length);
		var lines = data.toString().split('\r\n');
		var firstLineChunks = lines[0].split(' ');
		
		if(this.currentPendingResponseBufferPosition)
		{
			//sys.log("QQQQQQQQQQQ: GGGGGGGGOTTT NEXT DATA FRAGMENT! " + sys.inspect(this.pendingResponseBuffer));
			data.copy(this.pendingResponseBuffer, this.currentPendingResponseBufferPosition, 0, data.length);
			//sys.log("QQQQQQQQQQQ: pendingResponseBuffer: " + this.pendingResponseBuffer);

			if(this.currentPendingResponseBufferPosition + data.length == this.pendingResponseBuffer.length) {
				//sys.log("QQQQQQQQQQQ - DDDDDDDDDDDONE!!!!");
				cmd.emit('data', this.pendingResponseBuffer, obj);
				this.currentPendingResponseBufferPosition = 0;
			}
			else {
				this.currentPendingResponseBufferPosition = this.currentPendingResponseBufferPosition + data.length;
				//sys.log("QQQQQQQQQQQ - ADVANCING!!!!");
			}
		}
		else if(firstLineChunks[0] == "RESERVED" || firstLineChunks[0] == "FOUND" || firstLineChunks[0] == "OK" )
		{
			var bytesIndex;
			if(firstLineChunks[0] == "OK")
			{
				bytesIndex = 1;
			}
			else
			{
				bytesIndex = 2;
			}
			
			
			if((lines[0].length + 2 + Number(firstLineChunks[bytesIndex]) + 2) == Number(data.length))
			{
				this.currentPendingResponseBufferPosition = 0;
				cmd.emit('data', data, obj);
			}
			else
			{
				//sys.log("NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO!!!!!!!!!!!!!!!");
				//sys.log("From header      : " + (lines[0].length + 2 + Number(firstLineChunks[2]) + 2));
				//sys.log("From data buffer : " + Number(data.length));
				//sys.log("NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO!!!!!!!!!!!!!!!");
				
				Debug.log("Response for this RESERVED spans multiple 'data's");
				
				this.pendingResponseBuffer = new Buffer(lines[0].length + 2 + Number(firstLineChunks[bytesIndex]) + 2);
				data.copy(this.pendingResponseBuffer, 0, 0, data.length);
				this.currentPendingResponseBufferPosition = data.length;
			}
		}
		else 
		{
			this.currentPendingResponseBufferPosition = 0;
			cmd.emit('data', data, obj);
		}
		// whacky hacky ends ---------------------------------------------------------------------
		
	};
	
	var requestExec = function(data) {
		Debug.log('request:');
		Debug.log(data);
		var rrr = _self.conn.write(data);
		//Debug.log("conn.write result: " + sys.inspect(rrr));
	};
	
	if(!this.conn) {
		this.conn = net.createConnection(this.port, this.address);
		this.conn.setNoDelay();
		this.conn.setKeepAlive();

		this.conn.addListener('connect', function() {
			Debug.log('connected: '+_self.address+':'+_self.port);
		});

		this.conn.addListener('end', function(err) {
			Debug.log('connection ended, writeOnly from now on');
		});

		this.conn.addListener('error', function(err) {
			_self.emit('error', err);
			Debug.log('connection error');
		});

		this.conn.addListener('close', function(err) {
			Debug.log('connection closed');
		});

		this.conn.addListener('connect', function() {
			requestExec(obj.command);
		});
	} else {
		this.conn.removeAllListeners('data');
		requestExec(obj.command);
	}
	
	this.conn.addListener('data', dataHandler);
	return cmd;
};

BeanstalkClient.prototype.disconnect = function() {
	this.conn.end();
	this.conn = null;
};

/**
* Beanstalk client commands below
*/
BeanstalkClient.prototype.use = function(tube) {
	return this.command({
		command: 'use '+tube+'\r\n',
		expected: 'USING'
	});
};

BeanstalkClient.prototype.watch = function(tube) {
	return this.command({
		command: 'watch '+tube+'\r\n',
		expected: 'WATCHING'
	});
};

BeanstalkClient.prototype.ignore = function(tube) {
	return this.command({
		command: 'ignore '+tube+'\r\n',
		expected: 'WATCHING'
	});
};

BeanstalkClient.prototype.put = function(data, priority, delay, ttr) {
	if(typeof priority == 'undefined') {
		priority = this.default_priority;
	}

	if(typeof delay == 'undefined') {
		delay = 0;
	}

	if(typeof ttr == 'undefined') {
		ttr = 100000;
	}
	
	return this.command({
		command: 'put '+priority+' '+delay+' '+ttr+' '+data.toString().length+'\r\n'+data+'\r\n',
		expected: 'INSERTED'
	});
};
BeanstalkClient.prototype.reserve = function() {
	return this.command({
		command: 'reserve\r\n',
		expected: 'RESERVED'
	});
};

BeanstalkClient.prototype.reserve_with_timeout = function(time) {
	return this.command({
		command: 'reserve-with-timeout '+time+'\r\n',
		expected: 'RESERVED'
	});
};

BeanstalkClient.prototype.touch = function(id) {
	return this.command({
		command: 'touch '+id+'\r\n',
		expected: 'TOUCHED'
	});
};

BeanstalkClient.prototype.deleteJob = function(id) {
	return this.command({
		command: 'delete '+id+'\r\n',
		expected: 'DELETED'
	});
};

BeanstalkClient.prototype.release = function(id, priority, delay) {
	if(typeof priority == 'undefined') {
		priority = this.default_priority;
	}

	if(typeof delay == 'undefined') {
		delay = 0;
	}

	return this.command({
		command: 'release '+id+' '+priority+' '+delay+'\r\n',
		expected: 'RELEASED'
	});
};

BeanstalkClient.prototype.bury = function(id, priority) {
	if(typeof priority == 'undefined') {
		priority = this.default_priority;
	}

	return this.command({
		command: 'bury '+id+' '+priority+'\r\n',
		expected: 'BURIED'
	});
};

BeanstalkClient.prototype.kick = function(bound) {
	return this.command({
		command: 'kick '+bound+'\r\n',
		expected: 'KICKED'
	});
};

BeanstalkClient.prototype.peek = function(id) {
	return this.command({
		command: 'peek '+id+'\r\n',
		expected: 'FOUND'
	});
};

BeanstalkClient.prototype.peek_ready = function() {
	return this.command({
		command: 'peek-ready\r\n',
		expected: 'FOUND'
	});
};

BeanstalkClient.prototype.peek_delayed = function() {
	return this.command({
		command: 'peek-delayed\r\n',
		expected: 'FOUND'
	});
};

BeanstalkClient.prototype.peek_buried = function() {
	return this.command({
		command: 'peek-buried\r\n',
		expected: 'FOUND'
	});
};

BeanstalkClient.prototype.stats = function() {
	return this.command({
		command: 'stats\r\n',
		expected: 'OK',
		is_yaml: 1
	});
};

BeanstalkClient.prototype.stats_job = function(id) {
	return this.command({
		command: 'stats-job '+id+'\r\n',
		expected: 'OK',
		is_yaml: 1
	});
};

BeanstalkClient.prototype.stats_tube = function(tube) {
	return this.command({
		command: 'stats-tube '+tube+'\r\n',
		expected: 'OK',
		is_yaml: 1
	});
};

BeanstalkClient.prototype.list_tubes = function() {
	return this.command({
		command: 'list-tubes\r\n',
		expected: 'OK',
		is_yaml: 1
	});
};

BeanstalkClient.prototype.list_tube_used = function() {
	return this.command({
		command: 'list-tube-used\r\n',
		expected: 'USING'
	});
};

BeanstalkClient.prototype.pause_tube = function(tube, delay) {
	return this.command({
		command: 'pause-tube '+tube+' '+delay+'\r\n',
		expected: 'PAUSED'
	});
};

/**
* Create a client instance and return it
*/
var Beanstalk = function(server) {
	var c = new BeanstalkClient;
	return c.Instance(server);
};

/**
* Expose to node
*/
exports.Client = Beanstalk;
exports.Debug = Debug;
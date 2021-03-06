var sys = require('sys');
var assert = require('assert');
var bs = require('../lib/beanstalk_client');

sys.puts('testing use, put, watch, reserve, bury, peek_buried');

var client = bs.Client();

var success = false;
var error = false;

client.use('burytest').onSuccess(function(data) {
	client.put('test').onSuccess(function(data) {
		sys.puts(sys.inspect(data));
		var test_id = data[0];
	
		client.watch('burytest').onSuccess(function(data) {
			client.reserve().onSuccess(function(data) {
				client.bury(test_id).onSuccess(function(data) {
					sys.puts(sys.inspect(data));

					client.peek_buried().onSuccess(function(data) {
						sys.puts(sys.inspect(data));
						assert.ok(data);
						assert.equal(data.id, test_id);
						assert.equal(data.data, 'test');
						assert.equal(typeof data, 'object');
						success = true;
		
						client.deleteJob(test_id).onSuccess(function() {
							client.disconnect();
						});
					});
				});
			});
		});
	});
});

client.addListener('error', function() {
	error = true;
});

process.addListener('exit', function() {
	assert.ok(!error);
	assert.ok(success);
	sys.puts('test passed');
});
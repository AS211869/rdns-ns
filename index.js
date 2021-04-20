const dgram = require('dgram');
const server = dgram.createSocket('udp6');
const serverTCP = require('net').createServer();
const { EventEmitter } = require('events');
const dnsPacket = require('dns-packet');
const ip6 = require('ip6');
const isInSubnet = require('is-in-subnet').isInSubnet;

// https://support.umbrella.com/hc/en-us/articles/232254248-Common-DNS-return-codes-for-any-DNS-service-and-Umbrella-
let SERVFAIL_RCODE = 0x02;
let NXDOMAIN_RCODE = 0x03;
let NOTIMP_RCODE = 0x04;
let REFUSED_RCODE = 0x05;

var config = require('./config.json');
var prefixes = config.prefixes;

function removePrefixLength(prefix) {
	return prefix.replace(/\/[0-9]{1,3}$/, '');
}

function getPrefixLength(prefix) {
	return prefix.match(/\/[0-9]{1,3}$/)[0].replace('/', '');
}

// https://stackoverflow.com/a/32858679
function findFirstDiffPos(a, b) {
	var longerLength = Math.max(a.length, b.length);
	for (var i = 0; i < longerLength; i++) {
		if (a[i] !== b[i]) return i;
	}

	return -1;
}

function findPrefix(address) {
	return prefixes.filter(prefix => isInSubnet(address, prefix.prefix))[0];
}

function getChangeablePart(address) {
	var prefix = findPrefix(address);
	if (!prefix) {
		return null;
	}
	prefix = prefix.prefix;
	var prefixInfo = ip6.range(removePrefixLength(prefix), getPrefixLength(prefix), 128);
	var diff = findFirstDiffPos(prefixInfo.start, prefixInfo.end);
	return ip6.normalize(address).substring(diff).replace(/:/g, '');
}

function getUnchangeablePart(address) {
	var prefix = findPrefix(address);
	if (!prefix) {
		return null;
	}
	prefix = prefix.prefix;
	var prefixInfo = ip6.range(removePrefixLength(prefix), getPrefixLength(prefix), 128);
	var diff = findFirstDiffPos(prefixInfo.start, prefixInfo.end);
	return ip6.normalize(address).substring(0, diff).replace(/:/g, '');
}

function createRecordFromFormat(address) {
	var prefix = findPrefix(address);
	if (!prefix) {
		return null;
	}

	var staticAddress = prefix.static.filter(static => static.address === ip6.abbreviate(address))[0];

	if (staticAddress) {
		return staticAddress.record;
	}

	var recordData = getChangeablePart(address);

	return prefix.recordFormat.replace('{addr}', recordData);
}

function getStaticAddressFromRecord(record) {
	var staticAddress;
	prefixes.forEach(prefix => {
		var _static = prefix.static.filter(static => static.record === record);
		if (_static.length > 0) {
			staticAddress = _static[0].address;
		}
	});

	return staticAddress;
}

function getPrefixFromRecord(record) {
	var prefix = prefixes.filter(prefix => {
		var _regex = prefix.recordFormat.replace('{addr}', '[0-9a-f]+').replace(/\./g, '\\.');
		var regex = new RegExp(_regex);

		return regex.test(record);
	})[0];

	return prefix ? prefix.prefix : null;
}

function getUnchangeablePartFromRecord(record) {
	var prefix = prefixes.filter(prefix => {
		var _regex = prefix.recordFormat.replace('{addr}', '[0-9a-f]+').replace(/\./g, '\\.');
		var regex = new RegExp(_regex);

		return regex.test(record);
	})[0];

	if (!prefix) {
		return null;
	}

	var _regex = prefix.recordFormat.replace('{addr}', '([0-9a-f]+)').replace(/\./g, '\\.');
	var regex = new RegExp(_regex);

	return regex.exec(record)[1];
}

// https://stackoverflow.com/a/1772978
function chunk(str, n) {
	var ret = [];
	var i;
	var len;

	for (i = 0, len = str.length; i < len; i += n) {
		ret.push(str.substr(i, n));
	}

	return ret;
}

var event = new EventEmitter();

server.on('error', (err) => {
	console.log(`server error:\n${err.stack}`);
	server.close();
});

serverTCP.on('error', (err) => {
	console.log(`server error:\n${err.stack}`);
	serverTCP.close();
});

server.on('message', (msg, rinfo) => {
	console.log(`UDP connection from ${rinfo.address}:${rinfo.port}`);
	event.emit('query', 'udp', msg, rinfo);
});

serverTCP.on('connection', (socket) => {
	console.log(`TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);
	socket.on('data', function(data) {
		//console.log(data.toString());
		event.emit('query', 'tcp', data, {
			address: socket.remoteAddress,
			port: socket.remotePort,
			socket
		});
	});
});

function answerQuery(query, packet, type, sender) {
	var answerData = {
		type: 'response',
		id: packet ? packet.id : null,
		flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
		questions: [query],
		answers: []
	};

	if (query.type === 'PTR') {
		var isIPv6 = query.name.match(/ip6\.arpa$/) ? true : false;
		if (!isIPv6) {
			answerData.flags = REFUSED_RCODE;
		} else {
			var removeArpaAndReverse = query.name.replace('.ip6.arpa', '').split('').reverse().join('');
			var removeDots = removeArpaAndReverse.replace(/\./g, '');
			var addColons = chunk(removeDots, 4).join(':');

			var shortenedIP = ip6.abbreviate(addColons);

			var record = createRecordFromFormat(shortenedIP);

			answerData.answers = [{
				type: 'PTR',
				class: 'IN',
				name: query.name,
				data: record
			}];

			if (!record) {
				answerData.flags = REFUSED_RCODE;
			}
		}
	} else if (query.type === 'AAAA') {
		var staticAddress = getStaticAddressFromRecord(query.name);
		if (staticAddress) {
			answerData.answers = [{
				type: 'AAAA',
				class: 'IN',
				name: query.name,
				data: staticAddress
			}];
		} else {
			var prefix = getPrefixFromRecord(query.name);
			if (!prefix) {
				answerData.flags = REFUSED_RCODE;
			} else {
				var prefixWithoutLength = removePrefixLength(prefix);

				var ipWithoutColons = getUnchangeablePart(prefixWithoutLength).concat(getUnchangeablePartFromRecord(query.name));

				// eslint-disable-next-line no-redeclare
				var addColons = ip6.abbreviate(chunk(ipWithoutColons, 4).join(':'));

				console.log(addColons);

				answerData.answers = [{
					type: 'AAAA',
					class: 'IN',
					name: query.name,
					data: addColons
				}];
			}
		}
	}

	if ([NXDOMAIN_RCODE, REFUSED_RCODE].includes(answerData.flags)) {
		answerData.answers = [];
	}

	if (type === 'udp') {
		server.send(dnsPacket.encode(answerData), sender.port, sender.address, function(err) {
			if (err) {
				return console.error(err);
			}

			console.log(`Answered UDP request: ${query.type} ${query.name} for ${sender.address}`);
		});
	} else {
		sender.socket.write(dnsPacket.streamEncode(answerData), function() {
			console.log(`Answered TCP request: ${query.type} ${query.name} for ${sender.address}`);
			sender.socket.end();
		});
	}

}

function answerError(query, packet, type, rinfo, error) {
	var answerDataError = {
		type: 'response',
		id: packet ? packet.id : null,
		flags: error,
		questions: [query],
		answers: []
	};

	if (type === 'udp') {
		server.send(dnsPacket.encode(answerDataError), rinfo.port, rinfo.address, function(err) {
			if (err) {
				return console.error(err);
			}

			console.log(`Received invalid UDP request from ${rinfo.address}. Answered with error code: 0x0${error}`);
		});
	} else {
		rinfo.socket.write(dnsPacket.streamEncode(answerDataError), function() {
			console.log(`Received invalid TCP request from ${rinfo.address}. Answered with error code: 0x0${error}`);
			rinfo.socket.end();
		});
	}
}

event.on('query', function(type, msg, rinfo) {
	//console.log(`server got: ${msg} from ${rinfo.address}:${rinfo.port}`);
	let packet;
	if (type === 'udp') {
		packet = dnsPacket.decode(msg);
	} else {
		packet = dnsPacket.streamDecode(msg);
	}
	//console.log(packet);

	let query;

	var _throwError = SERVFAIL_RCODE;

	try {
		query = packet.questions[0];

		//var supportedTypes = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SRV', 'TXT'];
		var supportedTypes = ['A', 'AAAA', 'PTR'];

		if (!supportedTypes.includes(query.type)) {
			_throwError = NOTIMP_RCODE;
			throw new Error();
		}

		if (query.type === 'A') {
			// IPv4 is not supported
			_throwError = REFUSED_RCODE;
			throw new Error();
		}
	} catch (e) {
		answerError(query, packet, type, rinfo, _throwError);

		return;
	}

	try {
		answerQuery(query, packet, type, rinfo);
	} catch (e) {
		console.error(`Failed to answer query: ${e.message}`);

		answerError(query, packet, type, rinfo, _throwError);
	}
});

server.on('listening', () => {
	const address = server.address();
	console.log(`UDP server listening ${address.address}:${address.port}`);
});

server.bind(41514, '::');

serverTCP.on('listening', () => {
	const address = server.address();
	console.log(`TCP server listening ${address.address}:${address.port}`);
});

serverTCP.listen(41514, '::');
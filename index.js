const dgram = require('dgram');
const serverV4 = dgram.createSocket('udp4');
const serverV6 = dgram.createSocket('udp6');
const serverTCPV4 = require('net').createServer();
const serverTCPV6 = require('net').createServer();
const { EventEmitter } = require('events');
const dnsPacket = require('dns-packet');
const os = require('os');
const ip6 = require('ip6');
const isInSubnet = require('is-in-subnet').isInSubnet;

// https://support.umbrella.com/hc/en-us/articles/232254248-Common-DNS-return-codes-for-any-DNS-service-and-Umbrella-
//const NOERROR_RCODE = 0x00;
const SERVFAIL_RCODE = 0x02;
const NXDOMAIN_RCODE = 0x03;
//const NOTIMP_RCODE = 0x04;
const REFUSED_RCODE = 0x05;

var config = require('./config.json');
var prefixes = config.prefixes;

var hostname = os.hostname();
var version = `rdns-ns v${require('./package.json').version}`;

var cache = {};

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

function onlyZeroesAtStart(string) {
	return string.startsWith('0');

	// No idea what I was thinking with this
	var hasNonZero = false;
	var stringArr = string.split('');
	for (var i = 0; i < stringArr.length; i++) {
		if (stringArr[i] !== '0') {
			hasNonZero = true;
		} else if (hasNonZero) {
			return false;
		}
	}

	return true;
}

function getChangeablePart(address) {
	var prefix = findPrefix(address);
	if (!prefix) {
		return null;
	}

	prefix = prefix.prefix;
	var prefixInfo = ip6.range(removePrefixLength(prefix), getPrefixLength(prefix), 128);
	var diff = findFirstDiffPos(prefixInfo.start, prefixInfo.end);
	let addr = ip6.normalize(address).substring(diff);

	// It's a mess, but it works
	// This code is required to replace only the longest stretch
	// of zeroes with :: and to keep the rest of the address in
	// the expanded format
	if (address.includes('::') || address.includes(':0:')) {
		let replaceStart = -1;
		let replaceEnd = -1;
		let lastReplaceStart = -1;
		let lastReplaceEnd = -1;
		let isReplacing = false;
		let addrParts = addr.split('');
		let currentGroupStartsWithZero = false;
		for (var i = 0; i < addrParts.length; i++) {
			if (addrParts[i] === ':') {
				currentGroupStartsWithZero = onlyZeroesAtStart(addrParts.join('').substr(i + 1, 4));

				if (currentGroupStartsWithZero && isReplacing) {
					lastReplaceEnd++;
				}

				continue;
			}

			if (addrParts[i] === '0' && currentGroupStartsWithZero) {
				if (isReplacing === false) {
					lastReplaceStart = i;
					lastReplaceEnd = i;
					isReplacing = true;
				} else {
					lastReplaceEnd++;
				}
			}

			if (addrParts[i] !== '0' || addrParts.length - 1 === i) {
				isReplacing = false;
				if ((replaceEnd - replaceStart) < (lastReplaceEnd - lastReplaceStart)) {
					replaceStart = lastReplaceStart;
					replaceEnd = lastReplaceEnd;
				}
			}
		}

		if (replaceStart >= 0 && replaceEnd >= 0 && replaceEnd - replaceStart >= 2) {
			var tmpAddr = addr.substr(0, replaceStart);
			tmpAddr += tmpAddr.endsWith(':') ? ':' : '::';
			tmpAddr += addr.substr(replaceEnd + 1);
			tmpAddr = tmpAddr.replace('::', '--');

			// A subdomain cannot end with a dash
			if (!tmpAddr.endsWith('--')) {
				addr = tmpAddr;
			} else if (replaceEnd - replaceStart >= 3) {
				tmpAddr += '0';
				addr = tmpAddr;
			}
		}
	}

	return addr.replace(/:/g, '');
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

function isPrefixDomainAllowed(record) {
	var staticAddress = getStaticAddressFromRecord(record);

	var prefix = prefixes.filter(prefix => {
		// eslint-disable-next-line no-useless-escape
		var _regex = `${prefix.recordFormat.replace('{addr}', '[0-9a-f\-]+').replace(/\./g, '\\.')}$`;
		var regex = new RegExp(_regex);

		return regex.test(record);
	})[0];

	var shouldAllow = staticAddress || prefix;

	return shouldAllow ? true : false;
}

function getPrefixFromRecord(record) {
	var prefix = prefixes.filter(prefix => {
		// eslint-disable-next-line no-useless-escape
		var _regex = `^${prefix.recordFormat.replace('{addr}', '[0-9a-f\-]+').replace(/\./g, '\\.')}$`;
		var regex = new RegExp(_regex);

		return regex.test(record);
	})[0];

	return prefix ? prefix.prefix : null;
}

function getUnchangeablePartFromRecord(record) {
	var prefix = prefixes.filter(prefix => {
		// eslint-disable-next-line no-useless-escape
		var _regex = prefix.recordFormat.replace('{addr}', '[0-9a-f\-]+').replace(/\./g, '\\.');
		var regex = new RegExp(_regex);

		return regex.test(record);
	})[0];

	if (!prefix) {
		return null;
	}

	// eslint-disable-next-line no-useless-escape
	var _regex = prefix.recordFormat.replace('{addr}', '([0-9a-f\-]+)').replace(/\./g, '\\.');
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

serverV4.on('error', (err) => {
	console.log(`server error:\n${err.stack}`);
	serverV4.close();
});

serverV6.on('error', (err) => {
	console.log(`server error:\n${err.stack}`);
	serverV6.close();
});

serverTCPV4.on('error', (err) => {
	console.log(`server error:\n${err.stack}`);
	serverTCPV4.close();
});

serverTCPV6.on('error', (err) => {
	console.log(`server error:\n${err.stack}`);
	serverTCPV6.close();
});

serverV4.on('message', (msg, rinfo) => {
	if (config.debug) {
		console.log(`UDP connection from ${rinfo.address}:${rinfo.port}`);
	}
	event.emit('query', 'udp', msg, rinfo, serverV4);
});

serverV6.on('message', (msg, rinfo) => {
	if (config.debug) {
		console.log(`UDP connection from ${rinfo.address}:${rinfo.port}`);
	}
	event.emit('query', 'udp', msg, rinfo, serverV6);
});

serverTCPV4.on('connection', (socket) => {
	if (config.debug) {
		console.log(`TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);
	}
	socket.on('data', function(data) {
		event.emit('query', 'tcp', data, {
			address: socket.remoteAddress,
			port: socket.remotePort,
			socket
		});
	});
});

serverTCPV6.on('connection', (socket) => {
	if (config.debug) {
		console.log(`TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);
	}
	socket.on('data', function(data) {
		event.emit('query', 'tcp', data, {
			address: socket.remoteAddress,
			port: socket.remotePort,
			socket
		});
	});
});

function answerQuery(query, packet, type, sender, server) {
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

			var shortenedIP;
			var record;
			var _invalidIP = false;

			try {
				shortenedIP = ip6.abbreviate(addColons);
				record = createRecordFromFormat(shortenedIP);
			} catch (_) {
				_invalidIP = true;
			}

			if (record) {
				answerData.answers = [{
					type: 'PTR',
					class: 'IN',
					name: query.name,
					ttl: config.ttl,
					data: record
				}];
			} else if (!_invalidIP) {
				answerData.flags = REFUSED_RCODE;
			}
		}
	} else if (query.type === 'AAAA') {
		var shouldRefuse = isPrefixDomainAllowed(query.name);
		if (!shouldRefuse) {
			answerData.flags = REFUSED_RCODE;
		} else {
			var staticAddress = getStaticAddressFromRecord(query.name);
			if (staticAddress) {
				answerData.answers = [{
					type: 'AAAA',
					class: 'IN',
					name: query.name,
					ttl: 900,
					data: staticAddress
				}];
			} else {
				var prefix;
				try {
					prefix = getPrefixFromRecord(query.name);
				} catch (_) {
					// do nothing
				}

				if (prefix) {
					var prefixWithoutLength = removePrefixLength(prefix);

					var ipWithoutColons = getUnchangeablePart(prefixWithoutLength).concat(getUnchangeablePartFromRecord(query.name));

					if (ipWithoutColons.includes('--')) {
						var zerosToAdd = 32 - ipWithoutColons.replace('--', '').length;
						var zeros = '';
						for (var i = 0; i < zerosToAdd; i++) {
							zeros += '0';
						}
						ipWithoutColons = ipWithoutColons.replace('--', zeros);
					}

					// eslint-disable-next-line no-redeclare
					var addColons = ip6.abbreviate(chunk(ipWithoutColons, 4).join(':'));

					answerData.answers = [{
						type: 'AAAA',
						class: 'IN',
						name: query.name,
						ttl: config.ttl,
						data: addColons
					}];
				}
			}
		}
	} else {
		var shouldRefuseA = isPrefixDomainAllowed(query.name);

		if (!shouldRefuseA) {
			answerData.flags = REFUSED_RCODE;
		}
	}

	if ([NXDOMAIN_RCODE, REFUSED_RCODE].includes(answerData.flags) || answerData.answers.length === 0) {
		answerData.answers = [];
	} else {
		cache[query.name] = {};
		cache[query.name].answers = answerData.answers;
		cache[query.name].expiry = Date.now() + (config.ttl * 1000);
	}

	if (type === 'udp') {
		server.send(dnsPacket.encode(answerData), sender.port, sender.address, function(err) {
			if (err) {
				return console.error(err);
			}

			if (config.debug) {
				console.log(`Answered UDP request: ${query.type} ${query.name} for ${sender.address}`);
			}
		});
	} else {
		sender.socket.write(dnsPacket.streamEncode(answerData), function() {
			if (config.debug) {
				console.log(`Answered TCP request: ${query.type} ${query.name} for ${sender.address}`);
			}
			sender.socket.end();
		});
	}

}

function answerError(query, packet, type, rinfo, server, error) {
	var answerDataError = {
		type: 'response',
		id: packet ? packet.id : null,
		flags: error,
		questions: [query],
		answers: []
	};

	if (type === 'udp') {
		var _pUdp;
		try {
			_pUdp = dnsPacket.encode(answerDataError);
		} catch (_) {
			answerDataError.questions = [];
			_pUdp = dnsPacket.encode(answerDataError);
		}

		server.send(_pUdp, rinfo.port, rinfo.address, function(err) {
			if (err) {
				return console.error(err);
			}

			if (config.logErrors) {
				console.log(`Received invalid UDP request from ${rinfo.address}. Query ${query.type} ${query.name}. Answered with error code: 0x0${error}`);
			}
		});
	} else {
		var _pTcp;
		try {
			_pTcp = dnsPacket.streamEncode(answerDataError);
		} catch (_) {
			answerDataError.questions = [];
			_pTcp = dnsPacket.streamEncode(answerDataError);
		}

		rinfo.socket.write(_pTcp, function() {
			if (config.logErrors) {
				console.log(`Received invalid TCP request from ${rinfo.address}. Query ${query.type} ${query.name}. Answered with error code: 0x0${error}`);
			}
			rinfo.socket.end();
		});
	}
}

function createNSData(queryName) {
	var thisNS = [];
	config.thisNS.forEach(ns => {
		thisNS.push({
			type: 'NS',
			class: 'IN',
			name: queryName,
			ttl: config.ttl,
			data: ns
		});
	});

	return thisNS;
}

function answerNS(query, packet, type, rinfo, server) {
	var answerData = {
		type: 'response',
		id: packet ? packet.id : null,
		flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
		questions: [query],
		answers: []
	};

	if (query.name.match(/\.ip6\.arpa$/)) {
		prefixes.forEach(prefix => {
			var prefixWithoutLength = removePrefixLength(prefix.prefix);
			var unchangeablePart = getUnchangeablePart(prefixWithoutLength);
			if (parseInt(getPrefixLength(prefix.prefix)) % 4 !== 0) {
				unchangeablePart += query.name.split('.')[0];
			}
			var ptrRoot = chunk(unchangeablePart, 1).reverse().join('.').concat('.ip6.arpa');
			if (query.name === ptrRoot) {
				answerData.answers = createNSData(query.name);
				cache[query.name] = {};
				cache[query.name].answers = answerData.answers;
				cache[query.name].expiry = Date.now() + (config.ttl * 1000);
			} else {
				answerData.flags = NXDOMAIN_RCODE;
			}
		});
	} else {
		var prefixesWithThisName = prefixes.filter(prefix => prefix.recordFormat.split('.').slice(1).join('.') === query.name);
		if (prefixesWithThisName.length > 0) {
			answerData.answers = createNSData(query.name);
			cache[query.name] = {};
			cache[query.name].answers = answerData.answers;
			cache[query.name].expiry = Date.now() + (config.ttl * 1000);
		} else {
			answerData.flags = NXDOMAIN_RCODE;
		}
	}

	if (type === 'udp') {
		server.send(dnsPacket.encode(answerData), rinfo.port, rinfo.address, function(err) {
			if (err) {
				return console.error(err);
			}
		});
	} else {
		rinfo.socket.write(dnsPacket.streamEncode(answerData), function() {
			rinfo.socket.end();
		});
	}
}

function answerTXTCH(query, packet, type, rinfo, server) {
	var questions = {
		'version.bind': version,
		'hostname.bind': hostname
	};

	if (config.idServer) {
		questions['id.server'] = config.idServer;
	}

	var answerData = {
		type: 'response',
		id: packet ? packet.id : null,
		flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
		questions: [query],
		answers: []
	};

	var answersTmp = {
		type: 'TXT',
		class: 'CH',
		name: query.name,
		data: ''
	};

	if (Object.prototype.hasOwnProperty.call(questions, query.name)) {
		answersTmp.data = questions[query.name];
		answerData.answers = [answersTmp];
	} else {
		answerData.flags |= REFUSED_RCODE;
	}

	if (type === 'udp') {
		server.send(dnsPacket.encode(answerData), rinfo.port, rinfo.address, function(err) {
			if (err) {
				return console.error(err);
			}
		});
	} else {
		rinfo.socket.write(dnsPacket.streamEncode(answerData), function() {
			rinfo.socket.end();
		});
	}
}

function answerCache(answerData, type, rinfo, server) {
	if (type === 'udp') {
		server.send(dnsPacket.encode(answerData), rinfo.port, rinfo.address, function(err) {
			if (err) {
				return console.error(err);
			}
		});
	} else {
		rinfo.socket.write(dnsPacket.streamEncode(answerData), function() {
			rinfo.socket.end();
		});
	}
}

event.on('query', function(type, msg, rinfo, server) {
	let packet;
	if (type === 'udp') {
		packet = dnsPacket.decode(msg);
	} else {
		packet = dnsPacket.streamDecode(msg);
	}

	let query;

	var _throwError = SERVFAIL_RCODE;

	try {
		query = packet.questions[0];

		if (query.type === 'TXT' && query.class === 'CH') {
			return answerTXTCH(query, packet, type, rinfo, server);
		}
	} catch (e) {
		answerError(query, packet, type, rinfo, server, _throwError);

		return;
	}

	var answerData = {
		type: 'response',
		id: packet ? packet.id : null,
		flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
		questions: [query],
		answers: []
	};

	if (Object.keys(cache).length > config.maxCache) {
		cache = {};
	}

	try {
		if (query.type === 'NS') {
			if (Object.prototype.hasOwnProperty.call(cache, query.name)) {
				if (cache[query.name].expiry > Date.now()) {
					cache[query.name].answers.forEach(answer => {
						answer.ttl = Math.round((cache[query.name].expiry - Date.now()) / 1000);
					});

					answerData.answers = cache[query.name].answers;
					return answerCache(answerData, type, rinfo, server);
				} else {
					delete cache[query.name];
				}
			}
			return answerNS(query, packet, type, rinfo, server);
		}
	} catch (e) {
		if (config.logErrors) {
			console.error(`Failed to answer query: ${e.message}`);
			console.error(e);
		}

		answerError(query, packet, type, rinfo, server, _throwError);
	}

	try {
		if (Object.prototype.hasOwnProperty.call(cache, query.name)) {
			if (cache[query.name].expiry > Date.now()) {
				cache[query.name].answers.forEach(answer => {
					answer.ttl = Math.round((cache[query.name].expiry - Date.now()) / 1000);
				});

				answerData.answers = cache[query.name].answers;
				return answerCache(answerData, type, rinfo, server);
			} else {
				delete cache[query.name];
			}
		}
		answerQuery(query, packet, type, rinfo, server);
	} catch (e) {
		if (config.logErrors) {
			console.error(`Failed to answer query: ${e.message}`);
			console.error(e);
		}

		answerError(query, packet, type, rinfo, server, _throwError);
	}
});

serverV4.on('listening', () => {
	const address = serverV4.address();
	console.log(`UDP server listening ${address.address}:${address.port}`);
});

serverV6.on('listening', () => {
	const address = serverV6.address();
	console.log(`UDP server listening ${address.address}:${address.port}`);
});

serverV4.bind(config.listenPort, config.listenOn);
serverV6.bind(config.listenPort, config.listenOnV6);

serverTCPV4.on('listening', () => {
	const address = serverTCPV4.address();
	console.log(`TCP server listening ${address.address}:${address.port}`);
});

serverTCPV6.on('listening', () => {
	const address = serverTCPV6.address();
	console.log(`TCP server listening ${address.address}:${address.port}`);
});

serverTCPV4.listen(config.listenPort, config.listenOn);
serverTCPV6.listen(config.listenPort, config.listenOnV6);
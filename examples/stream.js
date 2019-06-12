/**
 * tsla_ws - create websocket connection to Tesla streaming endpoint
 *
 * @param {number} vid - vehicle_id as returned by /vehicles API call
 * @param {string} token - tokens[0] returned by /vehicles API call
 */
var ws, lastToken;
function tsla_ws(vid, token) {
	if (lastToken !== token) {
		ulog('stream token changed ' + lastToken + ' -> ' + token);
		lastToken = token;
	}
	if (ws) {
		return;
	}
	ulog('opening new websocket, vid=' + vid + ', token=' + token);
	ws = new WebSocket('wss://streaming.vn.teslamotors.com/streaming/', {
		followRedirects: true,
	});

	ws.on('open', () => {
		const msg = {
			msg_type: 'data:subscribe',
			token: new Buffer.from(creds.email + ':' + token).toString('base64'),
			value: teslams.stream_columns.join(','),
			tag: vid.toString(),
		};
		ws.send(JSON.stringify(msg));
	});
	ws.on('close', (code, reason) => {
		util.log('websocket closed, code=' + code + ', reason=' + reason);

		ws = undefined;
		if (lastToken && teslafi.polling) {
			tsla_ws(vid, lastToken);
		}
	});
	ws.on('error', (err) => {
		util.log('websocket error: ' + err);
		ws = undefined;
	});
	ws.on('message', (data) => {
		const msg = JSON.parse(data);
		switch (msg.msg_type) {
		case 'control:hello':
			break;
		case 'data:error':
			util.log('data:error ' + msg.error_type);
			ws.close();
			break;
		case 'data:update':
//			ulog('stream: ' + msg.value);
			const streamdata = csv2stream(msg.value);

			if (argv.file) {
				stream.write(data.toString() + '\n');
			}
			if (argv.mqtt) {
				if (streamdata.shift_state) {
					publish(argv.topic + '/stream', JSON.stringify(streamdata), {retain: true});
				}
				topics.weather.refresh(streamdata.position.coordinates);
				topics.streamcsv.changed(msg.value);
			}
			if (argv.db && streamdata.shift_state) {
				updateDb(colStream, streamdata);
			}
			break;
		default:
			util.log(msg);
			break;
		}
	});
}

/**
 * csv2stream - convert csv to MongoDB object
 *
 * @param {string} csv - realtime streaming data returned from Tesla
 */
function csv2stream(csv) {
	const array = csv.split(',');
	return {
		drive: parseInt(topics.drive.value),
		timestamp: parseInt(array[0]),
		speed: (array[1] !== '') ? parseInt(array[1]) : 0,
		odometer: parseFloat(array[2]),
		soc: parseInt(array[3]),
		elevation: parseInt(array[4]),
		power: parseFloat(array[8]),
		shift_state: array[9],
		range: parseFloat(array[10]),
		est_range: parseFloat(array[11]),
		est_heading: parseInt(array[5]),
		position: {
			type: 'Point',
			coordinates: [parseFloat(array[7]), parseFloat(array[6])]
		}
	};
}
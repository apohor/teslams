#!/usr/bin/env node
//
// streaming.js
//
// Stream data from Tesla's streaming API to either a flat file or a MongoDB database
//
var request = require('request');
var teslams = require('../teslams.js');
var fs = require('fs');
var util = require('util');
var JSONbig = require('json-bigint');

function argchecker( argv ) {
    if (argv.db === true) throw 'MongoDB database name is unspecified. Use -d, --db <dbname>';
}

var usage = 'Usage: $0 -u <username> -p <password> [-sz] \n' +
    '   [--file <filename>] [--db <MongoDB database>] \n' +
    '   [--mqtt <mqtt://hostname>] [--topic <mqtt_topic>] \n' +
    '   [--values <value list>] [--maxrpm <#num>] [--vehicle offset] [--naptime <#num_mins>]'; 

var collectionS, collectionA;
var firstTime = true;
var MongoClient;
var stream;
var last = 0; // datetime for checking request rates
var rpm = 0; // REST API Request Per Minute counter
var slast = 0; // datetime for checking streaming request rates
var srpm = 0; // Streaming URL Request Per Minute counter
var lastss = "init"; // last shift state
var ss = "init"; // shift state
var napmode = false; // flag for enabling pause to allow sleep to set in 
var sleepmode = false;
var napTimeoutId;
var sleepIntervalId;
// various instance counters to avoid multiple concurrent instances
var pcount = 0; 
var scount = 0;
var icount = 0;
var ncount = 0;

var argv = require('optimist')
    .usage(usage)
    .check(argchecker)
    .alias('u', 'username')
    .describe('u', 'Teslamotors.com login')
    .alias('p', 'password')
    .describe('p', 'Teslamotors.com password')
    .alias('d', 'db')
    .describe('d', 'MongoDB database name')
    .alias('s', 'silent')
    .describe('s', 'Silent mode: no output to console')
    .alias('z', 'zzz')
    .describe('z', 'enable sleep mode checking')
    .boolean(['s', 'z'])
    .alias('f', 'file')
    .describe('f', 'Comma Separated Values (CSV) output filename')
 //   .default('f', 'streaming.out')
    .alias('r', 'maxrpm')
    .describe('r', 'Maximum number of requests per minute')
    .default('r', 6)
    .alias('n', 'naptime')
    .describe('n', 'Number of minutes to nap')
    .default('n', 30)
    .alias('N', 'napcheck')
    .describe('N', 'Number of minutes between nap checks')
    .default('N', 1)
    .alias('O', 'vehicle')   
    .describe('O', 'Select the vehicle offset (i.e. 0 or 1) for accounts with multiple vehicles')
    .default('O', 0)
    .alias('S', 'sleepcheck')
    .describe('S', 'Number of minutes between sleep checks')
    .default('S', 1)
    .alias('v', 'values')
    .describe('v', 'List of values to collect')
    .default('v', 'speed,odometer,soc,elevation,est_heading,est_lat,est_lng,power,shift_state,range,est_range,heading')
    .alias('?', 'help')
    .describe('?', 'Print usage information');

// get credentials either from command line or ~/.teslams/config.json
var creds = require('./config.js').config(argv);

argv = argv.argv;
//convert time values from minutes to milliseconds
argv.napcheck *= 60000;
argv.sleepcheck *= 60000;
argv.naptime *= 60000;

if ( argv.help == true ) {
    console.log(usage);
    process.exit(1);
}

var nFields = argv.values.split(",").length + 1; // number of fields including ts

if (!argv.db && !argv.file) {
    console.log('No outputs specified. Add one (or more) of --db, --file flags to specify outputs');
    process.exit();
}
if (argv.db) {
    MongoClient = require('mongodb').MongoClient;
    // TODO: maybe add a mongouri config paramter to the config.json so people can set this explicitly
    var mongoUri = process.env.MONGOLAB_URI|| process.env.MONGOHQ_URI || 'mongodb://127.0.0.1:27017/' + argv.db;

    MongoClient.connect(mongoUri, function(err, db) {
        if(err) throw err;
	dbo=db.db(argv.db);
        collectionS = dbo.collection('tesla_stream');
        collectionA = dbo.collection('tesla_aux');
    });
} 
if (argv.file) {
    if (argv.file === true) {
        console.log('No output filename specified. Using ./streaming.out');
        argv.file = 'streaming.out';
    }
    stream = fs.createWriteStream(argv.file);
}

function tsla_poll( vid, token ) {    
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
			ulog('stream: ' + msg.value);
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

function getAux() {
    // make absolutely sure we don't overwhelm the API
    var now = new Date().getTime();
    if ( now - last < 60000) { // last request was within the past minute
        ulog( 'getAux: ' + rpm + ' of ' + argv.maxrpm + ' REST requests since ' + last);
        if ( now - last < 0 ) {
            ulog('Warn: Clock moved backwards - Daylight Savings Time??');
            rpm = 0;
            last = now;
        } else if ( rpm > argv.maxrpm ) {
            ulog ('Throttling Auxiliary REST requests due to too much REST activity');
            return;
        }
    } else { // longer than a minute since last request
        rpm = 0;
        last = now;
    }
    // check if the car is napping
    if (napmode || sleepmode) {
        ulog('Info: car is napping or sleeping, skipping auxiliary REST data sample');
        //TODO add periodic /vehicles state check to see if nap mode should be cancelled because car is back online again
        return;
    } else {
        rpm = rpm + 2; // increase REST request counter by 2 for following requests
        ulog( 'getting charge state Aux data');
        teslams.get_charge_state( getAux.vid, function(data) {
            var doc = { 'ts': new Date().getTime(), 'chargeState': data };
            if (argv.db && (data.charge_limit_soc !== undefined))  {
                collectionA.insert(doc, { 'safe': true }, function(err,docs) {
                    if(err) throw err;
                });
            }
            if (argv.ifttt) {
                var options = {
                    method: 'POST', 
                    url: ifttt, 
                    form: { value1: "charge_state", value2: JSON.stringify(data) }
                };
                request( options, function (error, response, body) {
                    ulog( 'IFTTT POST returned ' + response.statusCode );
                });
            }
        });
        ulog( 'getting climate state Aux data');
        teslams.get_climate_state( getAux.vid, function(data) {
            var ds = JSON.stringify(data), doc;
            if (ds.length > 2 && ds != JSON.stringify(getAux.climate)) {
                getAux.climate = data;
                doc = { 'ts': new Date().getTime(), 'climateState': data };
                if (argv.db && (data.inside_temp !== undefined)) {                  
                    collectionA.insert(doc, { 'safe': true }, function(err,docs) {
                        if(err) throw err;
                    });
                }
                if (argv.ifttt) {
                    var options = {
                        method: 'POST', 
                        url: ifttt, 
                        form: { value1: "climate_state", value2: JSON.stringify(data) }
                    };
                    request( options, function (error, response, body) {
                        ulog( 'IFTTT POST returned ' + response.statusCode );
                    });
                }
            }    
        });
    }
}

function storeVehicles(vehicles) {
    var doc = { 'ts': new Date().getTime(), 'vehicles': vehicles };
    if (argv.db && (vehicles !== undefined)) {
        collectionA.insert(doc, { 'safe': true }, function (err, docs) {
            if (err) console.dir(err);
        });
    }

    rpm = rpm + 2; // increment REST request counter for following 2 requests
    teslams.get_vehicle_state(vehicles.id, function(data) {
        ulog( util.inspect(data));
        doc = { 'ts': new Date().getTime(), 'vehicleState': data };
        if (argv.db && (data.car_version !== undefined)) {
            collectionA.insert(doc, { 'safe': true }, function (err, docs) {
                if (err) console.dir(err);
            });
        }
    });
    teslams.get_gui_settings(vehicles.id, function(data) {
        ulog(util.inspect(data));
        doc = { 'ts': new Date().getTime(), 'guiSettings': data };
        if (argv.db && (data.gui_distance_units !== undefined )) {
            collectionA.insert(doc, { 'safe': true }, function (err, docs) {
                if (err) console.dir(err);
            });
        }
    });
}

// if we are storing into a database or publishing to mqtt we also want to
// - store/publish the vehicle data (once, after the first connection)
// - store/publish some other REST API data around climate and charging (every minute)
function initdb(vehicles) {
    storeVehicles(vehicles);
    getAux.vid = vehicles.id;
    setInterval(getAux, 60000); // also get non-streaming data every 60 seconds
}

function ulog( string ) {
    if (!argv.silent) {
        util.log( string );
    }
}

function initstream() {
    icount++;
    if ( icount > 1 ) {
        ulog('Debug: Too many initializers running, exiting this one');
        icount = icount - 1;
        return;
    }   
    if (napmode) {
        ulog('Info: car is napping, skipping initstream()');
        icount = icount - 1;
        return;
    } 
    // make absolutely sure we don't overwhelm the API
    var now = new Date().getTime();
    if ( now - last < 60000) { // last request was within the past minute
        ulog( rpm + ' of ' + argv.maxrpm + ' REST requests since ' + last);
        if ( now - last < 0 ) {
            ulog('Warn: Clock moved backwards - Daylight Savings Time??');
            rpm = 0;
            last = now;
        } else if (rpm > argv.maxrpm) { // throttle check
            util.log('Warn: throttling due to too many REST API requests');
            setTimeout(function() { 
                initstream(); 
            }, 60000); // 1 minute
            icount = icount - 1;
            return;
        }       
    } else { // longer than a minute since last request
        last = now;
        rpm = 0; // reset the REST API request counter
    }
    rpm++; // increment the REST API request counter
    // adding support for selecting which vehicle to poll from a multiple vehicle account 
    teslams.all( { email: creds.username, password: creds.password }, function ( error, response, body ) {
        var vdata, vehicles;
        //check we got a valid JSON response from Tesla
        try { 
            vdata = JSONbig.parse(body); 
        } catch(err) { 
            ulog('Error: unable to parse vehicle data response as JSON, login failed. Trying again.'); 
            setTimeout(function() { 
                initstream(); 
            }, 10000); // 10 second
            icount = icount - 1;
            return;
            //process.exit(1);
        }
        //check we got an array of vehicles and get the right one using the (optionally) specified offset
        if (!util.isArray(vdata.response)) {
            ulog('Error: expecting an array if vehicle data from Tesla but got this:');
            util.log( vdata.response );
            process.exit(1);
        }
        // use the vehicle offset from the command line (if specified) to identify the right car in case of multi-car account
        vehicles = vdata.response[argv.vehicle];
        if (vehicles === undefined) {
            ulog('Error: No vehicle data returned for car number ' + argv.vehicle);
            process.exit(1);    
        }
    // end of new block added for multi-vehicle support
    // teslams.vehicles( { email: creds.username, password: creds.password }, function ( vehicles ) {  
        if ( typeof vehicles == "undefined" ) {
            console.log('Error: undefined response to vehicles request' );
            console.log('Exiting...');
            process.exit(1);
        }
        if (vehicles.state == undefined) {
            ulog( util.inspect( vehicles) ); // teslams.vehicles call could return and error string
        }
        if (argv.zzz && vehicles.state != 'online') { //respect sleep mode
            var timeDelta = Math.floor(argv.napcheck / 60000) + ' minutes';
            if (argv.napcheck % 60000 != 0) {
                timeDelta += ' ' + Math.floor((argv.napcheck % 60000) / 1000) + ' seconds';
            }
            ulog('Info: car is in (' + vehicles.state + ') state, will check again in ' + timeDelta);
            napmode = true;
            // wait for 1 minute (default) and check again if car is asleep
            setTimeout(function() { 
                napmode = false;
                sleepmode = true;
                initstream();
            }, argv.napcheck); // 1 minute (default)
            icount = icount - 1;
            return;     
        } else if ( typeof vehicles.tokens == "undefined" || vehicles.tokens[0] == undefined ) {
            ulog('Info: car is in (' + vehicles.state + ') state, calling /charge_state to reveal the tokens');
            rpm++;  // increment the REST API request counter           
            teslams.get_charge_state( vehicles.id, function( resp ) {
                if ( resp.charging_state != undefined ) {
                    // returned valid response so re-initialize right away
                    ulog('Debug: charge_state request succeeded (' + resp.charging_state + '). \n  Reinitializing...');
                    setTimeout(function() { 
                        initstream(); 
                    }, 1000); // 1 second
                    icount = icount - 1;
                    return;
                } else {
                    ulog('Warn: waking up with charge_state request failed.\n  Waiting 30 secs and then reinitializing...');
                    // charge_state failed. wait 30 seconds before trying again to reinitialize
                    // no need to set napmode = true because we are trying to wake up anyway
                    setTimeout(function() { 
                        initstream(); 
                    }, 30000);   // 30 seconds    
                    icount = icount - 1;
                    return;       
                } 
            }); 
        } else { // this is the valid condition so we have the required tokens and ids
            sleepmode = false;
            if (firstTime) {    // initialize only once
                firstTime = false;
                initdb(vehicles);
                if (argv.file) { // initialize first line of CSV file output with field names 
                    stream.write('timestamp,' + argv.values + '\n');
                }
            }
            tsla_poll( vehicles.id, vehicles.tokens[0] );
            icount = icount - 1;
            return;
        }
    }); 
}

// this is the main part of this program
// call the REST API in order get login and get the id, vehicle_id, and streaming password token
ulog('timestamp,' + argv.values);
initstream();

(function () {
    'use strict';
    const mqtt = require('mqtt') //require('mqtt/lib/connect/index');
    const os = require("os")
    const ip = require("ip")

    /**
   * Factory function for the MQTTBridge service
   */
    console.log("registering mqtt service")
    var MQTTService = function ($rootScope, $interval) {
        const root_topic = "smart-mirror"
        const hostname= os.hostname()
        // Command/subscribe topics keep the real hostname.
        const id = root_topic+"-"+hostname
        // HA discovery <object_id> may only use [a-zA-Z0-9_-]. Hostnames like
        // Mac-mini.local are rejected silently if used in the discovery topic.
        const haSafeId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_")
        const discovery_id = haSafeId(id)
        const ha_prefix='homeassistant/'
        // HA availability + MQTT last-will ("die") when the mirror process drops.
        const availabilityTopic = ha_prefix + 'switch/' + discovery_id + '/available'
        const payloadOnline = 'Online'
        const payloadOffline = 'Offline'
        // Primary switch state topic (autosleep / screen). Used for MQTT last-will so
        // an ungraceful close (kill window / crash) clears retained "on" in HA.
        const autosleepStateTopic = ha_prefix + 'switch/' + discovery_id + '/autosleep/state'
        const dieStatePayload = JSON.stringify({ state: false })
        let client = null;
        let client_connected = false;
        let client_reconnecting = false;
        const subscribed = []

        let pending_connect = []
        let running=false
        let handlersBound = false
        let stopping = false
        var service = {};
        //let connect_handle = null
        service.running = false;
        service.paused = true;

        console.log("in mqtt service")

        // Re-subscribe after broker restart (clean session / Mosquitto update).
        // mqtt.js also resubscribes, but we keep an explicit pass so HA commands
        // work even if the library's resubscribe map was cleared mid-reconnect.
        const resubscribeAll = () => {
            subscribed.forEach((entry) => {
                const topic = id + '/' + entry.topic + '/#'
                console.log("[MQTT] re-subscribing to " + topic)
                client.subscribe(topic, entry.options || { qos: 0 })
            })
        }

        const publishAvailability = (payload) => {
            if (!client) return
            console.log("[MQTT] availability " + payload + " -> " + availabilityTopic)
            client.publish(availabilityTopic, payload, { retain: true, qos: 1 })
        }

        const onBrokerOnline = (wasReconnect) => {
            client_connected = true
            console.log("[MQTT] connected" + (wasReconnect ? " (reconnect)" : ""))
            publishAvailability(payloadOnline)
            if (wasReconnect) {
                resubscribeAll()
                service.resend_states()
                // Broker may have wiped retained discovery during update.
                setTimeout(() => service.HomeAssistantDiscover(), 2000)
                client_reconnecting = false
            } else {
                pending_connect.forEach((d) => {
                    service.subscribe(d.topic, d.callback, d.options, true)
                })
                pending_connect = []
            }
        }

        service.start = function (topics) {
            if (client == null) {
                const options = {}
                process.env.DEBUG = "fribble*" // "mqttjs:ws"
                //options["rejectUnauthorized"] = self.config.mqttConfig.rejectUnauthorized;
                if (config.mqtt !== undefined && config.mqtt.server_address !== undefined && config.mqtt.server_port !== undefined) {
                    if (config.mqtt.username != "" && config.mqtt.userpassword != "") {
                        options.username = config.mqtt.username
                        options.password = Buffer.from(config.mqtt.userpassword)
                        options.port = config.mqtt.server_port
                        options.clientId = id
                        // Let mqtt.js own reconnect — a custom setInterval(connect)
                        // races it and clears its reconnect timer mid-attempt.
                        options.reconnectPeriod = 5000
                        options.connectTimeout = 30 * 1000
                        options.resubscribe = true
                        options.clean = true
                        // Die message: broker publishes this when the TCP session drops
                        // without a clean MQTT DISCONNECT (window kill, crash, force-quit).
                        // MQTT allows only one will — clear the screen state so HA is not
                        // left with retained "on". Graceful stop() also publishes Offline.
                        options.will = {
                            topic: autosleepStateTopic,
                            payload: dieStatePayload,
                            retain: true,
                            qos: 1
                        }
                        client = mqtt.connect("mqtt://" + config.mqtt.server_address, options)
                    }
                }
            }
            if (client && !handlersBound) {
                handlersBound = true

                client.on('connect', function () {
                    onBrokerOnline(client_reconnecting)
                })

                client.on('disconnect',()=>{
                    console.log("[MQTT] client disconnected")
                })

                client.on('error', function (error) { //MQTT library function. Returns ERROR when connection to the broker could not be established.
                    console.log("[MQTT] MQTT broker error: " , error);
                });

                client.on('close', function () {
                    console.log("[MQTT] connection closed");
                    if (stopping) {
                        client_connected = false
                        client_reconnecting = false
                        return
                    }
                    if (client_connected) {
                        client_connected = false
                        client_reconnecting = true
                    }
                })

                client.on('offline', function () { //MQTT library function. Returns OFFLINE when the client (our code) is not connected.
                    console.log("[MQTT] Could not establish connection to MQTT broker");
                    if (stopping) {
                        return
                    }
                    if (client_connected) {
                        client_connected = false
                        client_reconnecting = true
                    }
                    // mqtt.js will reconnect on its own via reconnectPeriod
                });

                client.on('message', function (topic, message) {  //MQTT library function. Returns message topic/payload when it arrives to subscribed topics.
                    console.log('[MQTT] MQTT message received. Topic: ' + topic + ', message: ' + message);
                    const entry = subscribed.filter(x => {
                        let id1 = topic.slice(id.length+1)
                        //console.log("mqtt id1  = "+ id1.length + " topic length ="+x.topic.length)
                        if (id1.startsWith(x.topic))
                            return true
                    })
                    if (entry.length) {
                        console.log("found subscribed topic=" + topic)
                        if (topic.endsWith('state'))
                            message='state'
                        if (typeof entry[0].callback === 'string')
                            $rootScope.broadcast(entry[0].callback, message.toString())
                        else
                            entry[0].callback(message.toString())
                    }
                });
                client.on('reconnect', ()=>{
                    console.log("[MQTT] client reconnect started")
                    client_reconnecting = true
                    client_connected = false
                })

                // Graceful Electron/window shutdown — publish off + offline before TCP drops.
                window.addEventListener('beforeunload', function () {
                    service.stop()
                })
            }
        }
        

        service.stop = function () {
            if (stopping || !client) {
                return
            }
            stopping = true
            console.log("[MQTT] stop / die — clearing screen state and availability")
            // Disable reconnect so close after end() does not start another session.
            if (client.options) {
                client.options.reconnectPeriod = 0
            }
            if (client_connected) {
                // Leave retained switch state off so HA does not keep "screen on".
                subscribed.forEach((t) => {
                    try {
                        service.publish(t.topic + "/state", false)
                    } catch (e) {
                        console.log("[MQTT] stop publish state failed", e)
                    }
                })
                publishAvailability(payloadOffline)
            }
            try {
                // Force-close WITHOUT a clean MQTT DISCONNECT so the broker still
                // fires the last-will if our retained publishes did not flush before
                // Electron tore down the renderer (typical when closing the window).
                client.end(true)
            } catch (e) {
                console.log("[MQTT] stop end failed", e)
            }
            client_connected = false
            client_reconnecting = false
        }

        service.subscribe = function (topic, callback , options = {} , retry=false) {
            if (client_connected) {
                let previous = subscribed.filter(entry => {
                    if (entry.topic === topic)
                        return true
                })
                if (previous.length) {
                    throw ("topic already registered")
                }
                // subscribe options: qos only (do not pass MQTT connect "clean" here)
                const subOpts = {
                    qos: options.qos !== undefined ? options.qos : 0
                }
                if (typeof callback === 'string' || typeof callback === 'function') {
                    subscribed.push({ "topic": topic, "callback": callback, "options": subOpts })
                    console.log("[MQTT] subscribing to "+id+'/'+topic)
                    client.subscribe(id+'/' + topic+'/#', subOpts)
                    if (!running) {
                        running = true
                        console.log("mqtt starting timer for ha discovery packet")
                        setTimeout(() => {
                            console.log("mqtt sending home assistant discover")
                            service.HomeAssistantDiscover();
                        }, 10000)
                    }
                }
                else
                    throw ("subscribe callback not correct type, string or function allowed")
            } else {
                if(!retry)
                    pending_connect.push({'topic':topic,'options':options,'callback':callback})
            }        
        }

        service.publish = function (topic, data) {
            if (client_connected == true) {
                const switch_type=(typeof data =='object'?'something':'switch')
                if (topic.endsWith('/state')) {
                    if (switch_type === 'switch') {
                        data = { state: data }
                    }
                    // Keep state topics under the same sanitized discovery id HA expects.
                    const entity = topic.replace(/\/state$/, '')
                    const stateTopic = ha_prefix + switch_type + '/' + discovery_id + '/' + haSafeId(entity) + '/state'
                    console.log("sending state for " + topic + " mqtt topic=" + stateTopic)
                    client.publish(stateTopic, JSON.stringify(data), {retain:true})
                }
                else
                    client.publish(root_topic+'/' + topic, JSON.stringify(data), {retain:true})
            }
        }
        service.resend_states = function (){
            subscribed.forEach(t => {
                setTimeout((t)=>{
                        t.device_state=t.callback('state')
                        console.log("mqtt resending state="+t.device_state+" for "+t.topic)
                        service.publish(t.topic+"/state",t.device_state)
                    },
                    1000, t
                )
            })
        }

        service.HomeAssistantDiscover = function () {

            console.log("HA discovery build for " + subscribed.length + " entities")
            subscribed.forEach(t => {
                t.device_state=t.callback('state')
                console.log("mqtt state received="+t.device_state)
                const thing = haSafeId(t.topic.split('/').pop())
                const entityId = discovery_id + "_" + thing
                // Topic object_id must be [a-zA-Z0-9_-] only; dots in .local hostnames break discovery.
                const discoverTopic = ha_prefix + 'switch/' + entityId + '/config'
                const stateTopic = ha_prefix + 'switch/' + discovery_id + '/' + thing + '/state'
                let discoverPacket = {
                    "device": {
                        "identifiers": [discovery_id],
                        "manufacturer": "sam detweiler",
                        "name": "Smart Mirror on "+hostname,
                        "configuration_url": "http://"+ip.address()+":"+config.remote.port+"/config.html",
                        "sw_version": "0.32"
 //                       "area":"Hall"
                    },
                    "availability_topic": availabilityTopic,
                    "payload_available": payloadOnline,
                    "payload_not_available": payloadOffline,
                    "object_id": entityId,
                    "unique_id": entityId,
                    "name": "screen",
                    "command_topic": id + '/' + t.topic, // root_topic+t.topic,
                    "payload_on": "on",
                    "payload_off": "off",
                    "state_topic": stateTopic,
                    "state_on": "True",
                    "state_off": "False",
                    "value_template": "{{ value_json.state }}",
                    "qos": 1
                }
                console.log("mqtt sending discover = "+discoverTopic+ " data="+JSON.stringify(discoverPacket,null,2))
                // Retained discovery is required so HA still sees the device after restart.
                let rc = client.publish(discoverTopic, JSON.stringify(discoverPacket), {retain: true, qos: 1})
                //console.log("mqtt discovery publish rc=", rc)// + JSON.stringify(rc, null, 2))
                setTimeout((t)=>{service.publish(t.topic+"/state",t.device_state)}, 1000, t)
            })
        }
        
        return service
    }
    angular.module('SmartMirror')
        .factory('MQTTService', MQTTService)
}());

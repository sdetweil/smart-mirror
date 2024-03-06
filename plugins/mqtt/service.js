(function () {
    'use strict';
    const mqtt = require('mqtt') //require('mqtt/lib/connect/index');
    const id = "smart-mirror-hall"
    const ha_prefix='homeassistant/'
    var client = null;
    var client_connected = false;
    const subscribed = []
    const root_topic = "smart-mirror/"
    let pending_connect = []
    let running=false
    /**
   * Factory function for the MQTTBridge service
   */
    console.log("registering mqtt service")
    var MQTTService = function ($rootScope, $interval) {
        var service = {};
        service.running = false;
        service.paused = true;
        console.log("in mqtt service")

        service.start = function (topics) {
            if (client == null) {
                const options = {}
                process.env.DEBUG = "fribble*" // "mqttjs:ws"
                //options["rejectUnauthorized"] = self.config.mqttConfig.rejectUnauthorized;
                if (config.mqtt !== undefined && config.mqtt.server_address !== undefined && config.mqtt.server_port !== undefined) {
                    console.log("[MQTT] connecting");
                    if (config.mqtt.username != "" && config.mqtt.userpassword != "") {
                        options.username = config.mqtt.username
                        options.password = Buffer.from(config.mqtt.userpassword)
                        options.port = config.mqtt.server_port
                    }
                    client = mqtt.connect("ws://" + config.mqtt.server_address /*+ ":" + config.mqtt.server_port*/, options)
                }
            }
            if (client) {
                client.on('connect', function () {
                    console.log("[MQTT] connected")
                    client_connected = true;
                    pending_connect.forEach(d => {
                        service.subscribe(d.topic, d.callback, d.options, true)
                    })
                    pending_connect = []                    
                })

                client.on('error', function (error) { //MQTT library function. Returns ERROR when connection to the broker could not be established.
                    console.log("[MQTT] MQTT broker error: " + error);
                });

                client.on('offline', function () { //MQTT library function. Returns OFFLINE when the client (our code) is not connected.
                    console.log("[MQTT] Could not establish connection to MQTT broker");
                    client_connected = false;
                    client.end();
                });

                client.on('message', function (topic, message) {  //MQTT library function. Returns message topic/payload when it arrives to subscribed topics.
                    console.log('[MQTT] MQTT message received. Topic: ' + topic + ', message: ' + message);
                    const entry = subscribed.filter(x => {
                        if (topic.slice(root_topic.length).startsWith(x.topic))
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
            }
        }
        

        service.stop = function () {

        }

        service.subscribe = function (topic, callback , options , retry=false) {
            if (client_connected) {
                let previous = subscribed.filter(entry => {
                    if (entry.topic === topic)
                        return true
                })
                if (previous.length) {
                    throw ("topic already registered")
                }
                if (typeof callback === 'string' || typeof callback === 'function') {
                    subscribed.push({ "topic": topic, "callback": callback, "options": options })
                    console.log("[MQTT] subscribing to "+root_topic+topic)
                    client.subscribe(root_topic + topic+'/#', options)
                    if (!running) {
                        running = true
                        console.log("starting timer for ha discovery packet")
                        setTimeout(() => {
                            console.log("sending home assistant discover")
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
                    console.log("sending state for " + topic + " mqtt topic=" + ha_prefix + id + '/' + topic)
                    client.publish(ha_prefix+switch_type+'/'+id+'/' + topic, JSON.stringify(data))
                }
                else
                    client.publish(root_topic + info.topic, JSON.stringify(info.data))
            }
        }

        service.HomeAssistantDiscover = function () {

            console.log("HA discovery build for " + subscribed.length + " entities")
            const discoverTopic = ha_prefix+'switch/' + id + '/config'
            subscribed.forEach(t => {
                t.device_state=t.callback('state')
                let thing = t.topic.split('/').slice(-1)
                let discoverPacket = {
                    "device": {
                        "identifiers": id,
                        "manufacturer": "sam detweiler",
                        "name": "Smart Mirror",
                        "configuration_url": "http://192.168.12.121:8080",
                        "sw_version": "0.32"
 //                       "area":"Hall"
                    },                    
                    "object_id": id+  '/' +thing,
                    "unique_id": id + '/' + thing,
                    "name": "screen on or off",
                    "command_topic": root_topic+t.topic,
                    "payload_on": "on",
                    "payload_off": "off",
                    "state_topic":ha_prefix+"switch/"+id+'/'+thing+"/state",
                    "state_on": true,
                    "state_off": false, 
                    "value_template": "{{ value_json.state }}",
                    "qos": 1
                }
                console.log("sending discover = "+discoverTopic+ " data="+JSON.stringify(discoverPacket,null,2))
                let rc = client.publish(discoverTopic, JSON.stringify(discoverPacket))                
                console.log("discovery publish rc=" + JSON.stringify(rc, null, 2))
                //client.publish(discoverPacket.state_topic, discoverPacket.state_on.toString())
                setTimeout((t)=>{service.publish(t.topic+"/state",t.device_state)}, 1000, t)
            })
        }
        
        return service
    }
    angular.module('SmartMirror')
        .factory('MQTTService', MQTTService)
}());

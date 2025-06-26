const express = require('express');
const router = express.Router();
const WebSocket = require('ws');
const axios = require('axios');  // Use Axios for making HTTP requests
const { db } = require('../../../handlers/db.js');
const { isUserAuthorizedForContainer } = require('../../../utils/authHelper');

router.ws("/console/:id", async (ws, req) => {
    if (!req.user) return ws.close(1008, "Authorization required");

    const { id } = req.params;
    const instance = await db.get(id + '_instance');

    if (!instance || !id) return ws.close(1008, "Invalid instance or ID");

    const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
    if (!isAuthorized) {
        return ws.close(1008, "Unauthorized access");
    }

    const node = instance.Node;
    const socket = new WebSocket(`ws://${node.address}:${node.port}/exec/${instance.ContainerId}`);

    socket.onopen = () => {
        socket.send(JSON.stringify({ "event": "auth", "args": [node.apiKey] }));
    };

    socket.onmessage = msg => {
        ws.send(msg.data);
    };

    socket.onerror = (error) => {
        ws.send('\x1b[31;1mDaemon instance appears to be down')
    };

    socket.onclose = (event) => {};

    ws.onmessage = msg => {
        socket.send(msg.data);
    };

    ws.on('close', () => {
        socket.close(); 
    });
});

router.get('/instance/action/:power/:id', async (req, res) => {
    if (!req.user) return res.status(403).json({ error: 'Login First' });
    const { power, id } = req.params;

    // Validate the action ('start', 'stop', 'restart')
    if (!['start', 'stop', 'restart'].includes(power)) {
        return res.status(400).json({ error: 'Invalid action. Valid actions are "start", "stop", and "restart".' });
    }

    try {
        // Fetch the instance from the database using the id
        const instance = await db.get(id + '_instance');

        if (!instance) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        // Build the target URL for the node
        const node = instance.Node;

        const requestData = {
            method: 'post',
            url: `http://${node.address}:${node.port}/instances/${id}/${power}`,
            auth: {
              username: 'Skyport',
              password: node.apiKey,
            },
          };
        // Send a POST request to the node to perform the action (start/stop/restart)
        try {
            const response = await axios(requestData);

            // If the response is OK (status 200), return success
            if (response.status === 200) {
                return res.json({ message: `Instance ${power}ed successfully.` });
            } else {
                return res.status(response.status).json({ error: `Failed to ${power} instance.` });
            }

        } catch (error) {
            console.error('Error communicating with node:', error);
            return res.status(500).json({ error: 'Failed to communicate with node.' });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = router;
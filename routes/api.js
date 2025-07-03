const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuid } = require('uuid');
const { sendPasswordResetEmail } = require('../handlers/email.js');
const { logAudit } = require('../handlers/auditlog');
const { db } = require('../handlers/db.js');
const nodemon = require('nodemon');

const saltRounds = 10;

// Middleware to check for a valid API key
async function validateApiKey(req, res, next) {
  const apiKey = req.query['key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'API key is required' });
  }

  try {
    const apiKeys = await db.get('apiKeys') || [];
    const validKey = apiKeys.find(key => key.key === apiKey);  // No need to remove 'Bearer ' prefix

    if (!validKey) {
      return res.status(401).json({ error: 'Invalid Key' });
    }

    req.apiKey = validKey;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to validate API key' });
  }
}

// Users
router.get('/api/users', validateApiKey, async (req, res) => {
  try {
    const users = await db.get('users') || [];

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

router.post('/api/getUser', validateApiKey, async (req, res) => {
  try {
    const { type, value } = req.body;

    if (!type || !value) {
      return res.status(400).json({ error: 'Type and value are required' });
    }

    const users = await db.get('users') || [];
    
    let user;
    if (type === 'email') {
      user = users.find(user => user.email === value);
    } else if (type === 'username') {
      user = users.find(user => user.username === value);
    } else {
      return res.status(400).json({ error: 'Invalid search type. Use "email" or "username".' });
    }
    
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }
    
    res.status(201).json(user);
  } catch (error) {
    console.error('Error retrieving user:', error);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

router.get('/api/auth/create-user', validateApiKey, async (req, res) => {
  try {
    let { username, email, password, userId, admin } = req.query; 

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const userExists = await db.get('users').then(users => 
      users && users.some(user => user.username === username)
    );

    if (userExists) {
      return res.status(409).json({ error: 'User already exists' });
    }

    if (!userId) {  // Check for userId in the query, not in body
      userId = uuidv4();  // Generate a new userId if not provided
    }

    const user = {
      userId: userId,
      username,
      email,
      password: await bcrypt.hash(password, saltRounds),
      accessTo: [],
      admin: admin === 'true'  // Ensure admin is a boolean, query params are always strings
    };

    let users = await db.get('users') || [];
    users.push(user);
    await db.set('users', users);

    res.status(201).json({ userId: user.userId, email, username: user.username, admin: user.admin });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create user' });
    console.log(error)
  }
});

router.post('/api/auth/reset-password', validateApiKey, async (req, res) => {
  const { email } = req.body;

  try {
    const users = await db.get('users') || [];
    const user = users.find(u => u.email === email);

    if (!user) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const resetToken = generateRandomCode(30);
    user.resetToken = resetToken;
    await db.set('users', users);

    const smtpSettings = await db.get('smtp_settings');
    if (smtpSettings) {
      await sendPasswordResetEmail(email, resetToken);
      res.status(200).json({ message: `Password reset email sent successfully (${resetToken})` });
    } else {
      res.status(200).json({ message: resetToken });
    }
  } catch (error) {
    console.error('Error handling password reset:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Instance
router.get('/api/instances', validateApiKey, async (req, res) => {
  try {
    const instances = await db.get('instances') || [];
    res.status(200).json(instances);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve instances' });
  }
});

router.ws("/api/instance/console/:id", async (ws, req) => {
  if (!req.user) return ws.close(1008, "Authorization required");

  const { id } = req.params;
  const instance = await db.get(id + '_instance');

  if (!instance || !id) return ws.close(1008, "Invalid instance or ID");

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

router.post('/api/instances/deploy', validateApiKey, async (req, res) => {
  const { image, imagename, memory, cpu, disk, ports, nodeId, name, user, primary, variables } =
    req.body;

  if (!image || !memory || !cpu || !ports || !nodeId || !name || !user || !primary) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const Id = uuid().split('-')[0];
    const node = await db.get(`${nodeId}_node`);
    if (!node) {
      return res.status(400).json({ error: 'Invalid node' });
    }

    const requestData = await prepareRequestData(
      image,
      memory,
      cpu,
      ports,
      name,
      node,
      Id,
      variables,
      imagename,
    );

    const response = await axios(requestData);

    // Check if the response status is 201
    if (response.status === 201) {
      await updateDatabaseWithNewInstance(
        response.data,
        user,
        node,
        image,
        memory,
        disk,
        cpu,
        ports,
        primary,
        name,
        Id,
        imagename,
      );

      return res.status(201).json({
        message: "DEPLOYMENT COMPLETE", // Custom message for successful deployment
        containerId: response.data.containerId,
        volumeId: response.data.volumeId,
      });
    } else {
      // Handle non-201 statuses
      return res.status(response.status).json({
        error: 'Failed to deploy container',
        details: response.data,
      });
    }
  } catch (error) {
    console.error('Error deploying instance:', error);
    res.status(500).json({
      error: 'Failed to create container',
      details: error.response ? error.response.data : 'No additional error info',
    });
  }
});

router.delete('/api/instance/delete', validateApiKey, async (req, res) => {
  const { id } = req.body;
  
  try {
    if (!id) {
      return res.status(400).json({ error: 'Missing ID parameter' });
    }
    
    const instance = await db.get(id + '_instance');
    if (!instance) {
      return res.status(400).json({ error: 'Instance not found' });
    }
    
    await deleteInstance(instance);
    res.status(201).json({ Message: 'The instance has successfully been deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete instances' });
  }
});

router.get('/api/instances/suspend', validateApiKey, async (req, res) => {
  const id = req.query.id;

  try {
    if (!id) {
      return res.status(422).json({ error: `Missing id` });
    }
    const instance = await db.get(id + '_instance');
    if (!instance) {
      return res.status(404).json({ error: `Instance Not Found` });
    }

    instance.suspended = true;
    await db.set(id + '_instance', instance);
    let instances = await db.get('instances') || [];

    let instanceToSuspend = instances.find(obj => obj.ContainerId === instance.ContainerId);
    if (instanceToSuspend) {
      instanceToSuspend.suspended = true;
    }

    await db.set('instances', instances);

    res.status(200).json({ success: `Server ${id} Have Been Suspended` });
  } catch (error) {
    console.error('Error in unsuspend instance endpoint:', error);
    res.status(500).send('An error occurred while unsuspending the instance');
  }
});

router.get('/api/instances/unsuspend', validateApiKey, async (req, res) => {
  const id = req.query.id;

  try {
    if (!id) {
      return res.status(422).json({ error: `Missing id` });
    }
    const instance = await db.get(id + '_instance');
    if (!instance) {
      return res.status(404).json({ error: `Instance Not Found` });
    }

    instance.suspended = false;

    await db.set(id + '_instance', instance);

    let instances = await db.get('instances') || [];

    let instanceToUnsuspend = instances.find(obj => obj.ContainerId === instance.ContainerId);
    if (instanceToUnsuspend) {
      instanceToUnsuspend.suspended = false;
    }

    await db.set('instances', instances);

    logAudit(req.user.userId, req.user.username, 'instance:unsuspend', req.ip);

    res.status(200).json({ success: `Server ${id} Have Been Unsuspended` });
  } catch (error) {
    console.error('Error in unsuspend instance endpoint:', error);
    res.status(500).send('An error occurred while unsuspending the instance');
  }
});

router.post('/api/getUserInstance', validateApiKey, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'Parameter "userId" is required' });
  }

  const userExists = await db.get('users').then(users => 
    users && users.some(user => user.userId === userId)
  );

  if (!userExists) {
    return res.status(400).json({ error: 'User not found' });
  }

  try {
    const userInstances = await db.get(`${userId}_instances`) || [];
    res.json(userInstances);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve user instances' });
  }
});

router.post('/api/getInstance', validateApiKey, async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'Parameter "id" is required' });
  }

  const instanceExists = await db.get('instances').then(server => 
    server && server.some(server => server.Id === id)
  );

  if (!instanceExists) {
    return res.status(400).json({ error: 'Instance not found' });
  }

  try {
    const instances = await db.get(`${id}_instance`) || [];
    res.json(instances);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve instances' });
  }
});

// Images
router.get('/api/images', validateApiKey, async (req, res) => {
  try {
    const images = await db.get('images') || [];
    res.json(images);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve images' });
  }
});

router.get('/api/name', validateApiKey, async (req, res) => {
  try {
    const name = await db.get('name') || 'PowerPort';
    res.json({ name });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve name' });
  }
});

// Nodes
router.get('/api/nodes', validateApiKey, async (req, res) => {
  try {
    const nodes = await db.get('nodes') || [];
    const nodeDetails = await Promise.all(nodes.map(id => db.get(id + '_node')));
    res.json(nodeDetails);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve nodes' });
  }
});

router.get('/api/nodes/create/:name/:tags/:ram/:disk/:processor/:address/:port', validateApiKey, async (req, res) => {
  const configureKey = uuidv4(); // Generate a unique configureKey
  const node = {
    id: uuidv4(),
    name: req.params.name,
    tags: req.params.tags,
    ram: req.params.ram,
    disk: req.params.disk,
    processor: req.params.processor,
    address: req.params.address,
    port: req.params.port,
    apiKey: null, // Set to null initially
    configureKey: configureKey, // Add the configureKey
    status: 'Unconfigured' // Status to indicate pending configuration
  };

  if (!req.params.name || !req.params.tags || !req.params.ram || !req.params.disk || !req.params.processor || !req.params.address || !req.params.port) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  await db.set(node.id + '_node', node); // Save the initial node info
  const updatedNode = await checkNodeStatus(node); // Check and update status

  const nodes = await db.get('nodes') || [];
  nodes.push(node.id);
  await db.set('nodes', nodes);

  res.status(201).json({ success: true });
});

router.get('/api/nodes/delete/:id', validateApiKey, async (req, res) => {
  const nodeId = req.params.nodeId;
  const nodes = await db.get('nodes') || [];
  const newNodes = nodes.filter(id => id !== nodeId);

  if (!nodeId) return res.send('Invalid node')

  await db.set('nodes', newNodes);
  await db.delete(nodeId + '_node');

  res.status(201).json({ Message: "The node has successfully deleted." });
});

router.get('/api/nodes/configure-command', validateApiKey, async (req, res) => {
  const { id } = req.query.id;
  try {
    // Fetch the node from the database
    const node = await db.get(id + '_node');
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    // Generate a new configure key
    const configureKey = uuidv4();

    // Update the node with the new configure key
    node.configureKey = configureKey;
    await db.set(id + '_node', node);

    // Construct the configuration command
    const panelUrl = `${req.protocol}://${req.get('host')}`;
    const configureCommand = `npm run configure -- --panel ${panelUrl} --key ${configureKey}`;

    // Return the configuration command
    res.json({
      nodeId: id,
      configureCommand: configureCommand
    });

  } catch (error) {
    console.error('Error generating configure command:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Function

function generateRandomCode(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Helper function to delete an instance
async function deleteInstance(instance) {
  try {
    await axios.get(`http://Skyport:${instance.Node.apiKey}@${instance.Node.address}:${instance.Node.port}/instances/${instance.ContainerId}/delete`);
    
    // Update user's instances
    let userInstances = await db.get(instance.User + '_instances') || [];
    userInstances = userInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set(instance.User + '_instances', userInstances);
    
    // Update global instances
    let globalInstances = await db.get('instances') || [];
    globalInstances = globalInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set('instances', globalInstances);
    
    // Delete instance-specific data
    await db.delete(instance.ContainerId + '_instance');
  } catch (error) {
    console.error(`Error deleting instance ${instance.ContainerId}:`, error);
    throw error;
  }
}

async function updateDatabaseWithNewInstance(
  responseData,
  userId,
  node,
  image,
  memory,
  disk,
  cpu,
  ports,
  primary,
  name,
  Id,
  imagename,
) {
  const rawImages = await db.get('images');
  const imageData = rawImages.find(i => i.Name === imagename);

  let altImages = imageData ? imageData.AltImages : [];

  const instanceData = {
    Name: name,
    Id,
    Node: node,
    User: userId,
    ContainerId: responseData.containerId,
    VolumeId: Id,
    Memory: parseInt(memory),
    Disk: disk,
    Cpu: parseInt(cpu),
    Ports: ports,
    Primary: primary,
    Image: image,
    AltImages: altImages,
    StopCommand: imageData ? imageData.StopCommand : undefined,
    imageData,
    Env: responseData.Env,
    State: responseData.state,
  };

  const userInstances = (await db.get(`${userId}_instances`)) || [];
  userInstances.push(instanceData);
  await db.set(`${userId}_instances`, userInstances);

  const globalInstances = (await db.get('instances')) || [];
  globalInstances.push(instanceData);
  await db.set('instances', globalInstances);

  await db.set(`${Id}_instance`, instanceData);
}

async function prepareRequestData(image, memory, cpu, ports, name, node, Id, variables, imagename) {
  const rawImages = await db.get('images');
  const imageData = rawImages.find(i => i.Name === imagename);

  const requestData = {
    method: 'post',
    url: `http://${node.address}:${node.port}/instances/create`,
    auth: {
      username: 'Skyport',
      password: node.apiKey,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    data: {
      Name: name,
      Id,
      Image: image,
      Env: imageData ? imageData.Env : undefined,
      Scripts: imageData ? imageData.Scripts : undefined,
      Memory: memory ? parseInt(memory) : undefined,
      Cpu: cpu ? parseInt(cpu) : undefined,
      ExposedPorts: {},
      PortBindings: {},
      variables,
      AltImages: imageData ? imageData.AltImages : [],
      StopCommand: imageData ? imageData.StopCommand : undefined,
      imageData,
    },
  };

  if (ports) {
    ports.split(',').forEach(portMapping => {
      const [containerPort, hostPort] = portMapping.split(':');

      // Adds support for TCP
      const tcpKey = `${containerPort}/tcp`;
      if (!requestData.data.ExposedPorts[tcpKey]) {
        requestData.data.ExposedPorts[tcpKey] = {};
      }

      if (!requestData.data.PortBindings[tcpKey]) {
        requestData.data.PortBindings[tcpKey] = [{ HostPort: hostPort }];
      }

      // Adds support for UDP
      const udpKey = `${containerPort}/udp`;
      if (!requestData.data.ExposedPorts[udpKey]) {
        requestData.data.ExposedPorts[udpKey] = {};
      }

      if (!requestData.data.PortBindings[udpKey]) {
        requestData.data.PortBindings[udpKey] = [{ HostPort: hostPort }];
      }
    });
  }

  return requestData;
}

/**
 * Checks the operational status of a node by making an HTTP request to its API.
 * Updates the node's status based on the response or sets it as 'Offline' if the request fails.
 * This status check and update are persisted in the database.
 *
 * @param {Object} node - The node object containing details such as address, port, and API key.
 * @returns {Promise<Object>} Returns the updated node object after attempting to verify its status.
 */
async function checkNodeStatus(node) {
  try {
    const RequestData = {
      method: 'get',
      url: 'http://' + node.address + ':' + node.port + '/',
      auth: {
        username: 'Skyport',
        password: node.apiKey
      },
      headers: { 
        'Content-Type': 'application/json'
      }
    };
    const response = await axios(RequestData);
    const { versionFamily, versionRelease, online, remote, docker } = response.data;

    node.status = 'Online';
    node.versionFamily = versionFamily;
    node.versionRelease = versionRelease;
    node.remote = remote;
    node.docker = docker;

    await db.set(node.id + '_node', node); // Update node info with new details
    return node;
  } catch (error) {
    node.status = 'Offline';
    await db.set(node.id + '_node', node); // Update node as offline if there's an error
    return node;
  }
}

module.exports = router;

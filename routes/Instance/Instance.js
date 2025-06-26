const axios = require('axios')
const express = require('express');
const router = express.Router();
const { db } = require('../../handlers/db.js');
const { isUserAuthorizedForContainer } = require('../../utils/authHelper');
const { loadPlugins } = require('../../plugins/loadPls.js');
const path = require('path');
const { config } = require('process');
const { fetchFiles } = require('../../utils/fileHelper');
const { isAuthenticated } = require('../../handlers/auth.js');

const plugins = loadPlugins(path.join(__dirname, '../../plugins'));

router.get("/instances", isAuthenticated, async (req, res) => {
    if (!req.user) return res.redirect('/');
    let instances = [];

    if (req.query.see === "other") {
        let allInstances = await db.get('instances') || [];
        instances = allInstances.filter(instance => instance.User !== req.user.userId);
    } else {
        const userId = req.user.userId;
        const users = await db.get('users') || [];
        const authenticatedUser = users.find(user => user.userId === userId);
        instances = await db.get(req.user.userId + '_instances') || [];
        const subUserInstances = authenticatedUser.accessTo || [];
        for (const instanceId of subUserInstances) {
            const instanceData = await db.get(`${instanceId}_instance`);
            if (instanceData) {
                instances.push(instanceData);
            }
        }
    }

    res.render('instances', {
        req,
        user: req.user,
        name: await db.get('name') || 'PowerPort',
        logo: await db.get('logo') || false,
        instances,
        config: require('../../config.json')
    });
});

router.get("/instance/:id", async (req, res) => {
    if (!req.user) return res.redirect('/');

    const { id } = req.params;
    if (!id) return res.redirect('/');

    let instance = await db.get(id + '_instance');
    if (!instance) return res.redirect('../instances');

    const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
    if (!isAuthorized) {
        return res.status(403).send('Unauthorized access to this instance.');
    }

    if(!instance.suspended) {
        instance.suspended = false;
        db.set(id + '_instance', instance);
    }

    if (instance.State === 'INSTALLING') {
        return res.redirect('../../instance/' + id + '/installing')
    }
    if(instance.suspended === true) {
        return res.redirect('../../instances?err=SUSPENDED');
   }

    const config = require('../../config.json');
    const { port, domain } = config;

    const allPluginData = Object.values(plugins).map(plugin => plugin.config);

    res.render('instance/instance', {
        req,
        ContainerId: instance.ContainerId,
        instance,
        port,
        domain,
        user: req.user,
        name: await db.get('name') || 'PowerPort',
        logo: await db.get('logo') || false,
        files: await fetchFiles(instance, ""),
        addons: {
            plugins: allPluginData
        }
    });
});

router.get("/instance/:id/installing", async (req,res) => {
   const { id } = req.params;
   if (!id) return res.redirect('/');

   let instance = await db.get(id + '_instance');
   if (!instance) return res.redirect('../instances');
   const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
   if (!isAuthorized) {
       return res.status(403).send('Unauthorized access to this instance.');
   }
   await checkState(id);
   res.render('instance/installing', {
    req,
    instance,
    user: req.user,
    name: await db.get('name') || 'PowerPort',
    logo: await db.get('logo') || false,
    config: require('../../config.json')
   });
});

router.get("/instance/:id/installing/status", async (req, res) => {
   const { id } = req.params;

   const instance = await db.get(id + '_instance');

   if (!instance) {
    return res.redirect('../../instances')
   }

   const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
   if (!isAuthorized) {
       return res.status(403).send('Unauthorized access to this instance.');
   }
    
    await checkState(id);
     
     res.status(200).json({ state: instance.State })
});

async function checkState(instanceId) {
    try {
      // Get the specific instance from the "instances" database
      const instance = await db.get(`${instanceId}_instance`);
  
      if (!instance) {
        return ("Instance not found.");
      }
  
      try {
        // Fetch the current state from the remote server
        const getStateUrl = `http://${instance.Node.address}:${instance.Node.port}/instances/${instance.Id}/states/get`;
        const getStateResponse = await axios.get(getStateUrl, {
          auth: {
            username: "Skyport",
            password: instance.Node.apiKey,
          },
        });
  
        const newState = getStateResponse.data.state;
  
        // Update the state on the remote server
        const setStateUrl = `http://${instance.Node.address}:${instance.Node.port}/instances/${instance.Id}/states/set/${newState}`;
        await axios.get(setStateUrl, {
          auth: {
            username: "Skyport",
            password: instance.Node.apiKey,
          },
        });
  
        // Update the instance state locally
        instance.State = newState;
  
        // Get the instance-specific database and ensure it has the "State" property
        const instanceDbKey = `${instanceId}_instance`; // Define the key for instance-specific database
        let instanceDb = await db.get(instanceDbKey);
  
        if (!instanceDb) {
          instanceDb = {};
        }
  
        instanceDb.State = newState;
  
        // Save the updated instance-specific database
        await db.set(instanceDbKey, instanceDb);
  
      } catch (instanceError) {
        console.error(`Error processing instance ${instance.Id}:`, instanceError.message);
      }
    } catch (error) {
      console.error("Error processing instances:", error.message);
    }
  }
  

module.exports = router;
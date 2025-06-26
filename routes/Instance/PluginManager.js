const express = require('express');
const axios = require('axios');
const router = express.Router();
const { db } = require('../../handlers/db.js');
const { isUserAuthorizedForContainer } = require('../../utils/authHelper');
const { fetchFiles } = require('../../utils/fileHelper');

const { loadPlugins } = require('../../plugins/loadPls.js');
const path = require('path');

const plugins = loadPlugins(path.join(__dirname, '../../plugins'));

const API_URL = 'https://api.spiget.org/v2/resources/free';
const DEFAULT_LOGO_URL = 'https://static.spigotmc.org/styles/spigot/xenresource/resource_icon.png';
const ITEMS_PER_PAGE = 50;
async function getPluginList() {
  try {
    const page = 1;
    const response = await axios.get(`${API_URL}?size=${ITEMS_PER_PAGE}&page=${page}&sort=-downloads`);
    return response.data;
  } catch (error) {
    console.error('Error fetching plugin list:', error);
    return [];
  }
}

async function getPluginDetails(id) {
  try {
    const response = await axios.get(`${BASE_URL}/plugin?id=${id}`);
    const plugin = response.data;

    return {
      id: plugin.id,
      name: plugin.name,
      link: plugin.link,
      description: plugin.description,
      logo: plugin.logo || DEFAULT_LOGO_URL, 
    };
  } catch (error) {
    console.error('Error fetching plugin details:', error);
    return null;
  }
}
async function getPluginVersions(id, minecraftVersion) {
  try {
    const response = await axios.get(`${BASE_URL}/plugin_versions?id=${id}`);
    const pluginVersions = response.data;

    // Filter versions based on the specified Minecraft version
    const filteredVersions = pluginVersions.filter(
      (version) => version.game_versions.includes(minecraftVersion)
    );

    if (filteredVersions.length === 0) {
      throw new Error(`No compatible versions found for Minecraft version ${minecraftVersion}`);
    }

    // Return the first valid version (you can modify logic if needed)
    const selectedVersion = filteredVersions[0];

    return {
      game_versions: selectedVersion.game_versions || [],
      download: selectedVersion.download || null,
      size: selectedVersion.size || null,
    };
  } catch (error) {
    console.error('Error fetching plugin versions:', error);
    return null;
  }
}

router.get("/instance/:id/plugins", async (req, res) => {
    if (!req.user) return res.redirect('/');

    const { id } = req.params;
    if (!id) return res.redirect('/');

    let instance = await db.get(id + '_instance');
    if (!instance) return res.redirect('../instances');

    const java = 'quay.io/skyport/java:21'

    if (!instance.Image === java) {
        return res.redirect('../../instance/' + id);
    }
    const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
    if (!isAuthorized) {
        return res.status(403).send('Unauthorized access to this instance.');
    }

    if(!instance.suspended) {
        instance.suspended = false;
        db.set(id + '_instance', instance);
    }

    if(instance.suspended === true) {
      return res.redirect('../../instances?err=SUSPENDED');
 }

    const config = require('../../config.json');
    const { port, domain } = config;

    const allPluginData = Object.values(plugins).map(plugin => plugin.config);

    res.render('instance/plugin_manager', {
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

router.get("/instance/:id/plugins/download", async (req, res) => {
  if (!req.user) return res.redirect('/');

  const { id } = req.params;
  let { downloadUrl, plugin_name } = req.query; // Destructure downloadUrl from query
  if (!id) return res.redirect('/instances');

  let instance = await db.get(id + '_instance');
  if (!instance) return res.redirect('../instances');

  const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
  if (!isAuthorized) {
    return res.status(403).send('Unauthorized access to this instance.');
  }

  if (!instance.suspended) {
    instance.suspended = false;
    db.set(id + '_instance', instance);
  }
  if(instance.suspended === true) {
    return res.redirect('../../instances?err=SUSPENDED');
}

  try {
    // Remove </pre> from the downloadUrl if it exists
    if (downloadUrl.includes("</pre>")) {
      downloadUrl = downloadUrl.replace("</pre>", "");
    }
    const encodedDownloadUrl = encodeURIComponent(downloadUrl);
    // Prepare the request to upload the plugin
    const requestData = {
      method: 'post',
      url: `http://${instance.Node.address}:${instance.Node.port}/fs/${instance.VolumeId}/files/plugin/${encodedDownloadUrl}/${plugin_name}`,
      auth: {
        username: 'Skyport',
        password: instance.Node.apiKey,
      },
      headers: {
        'Content-Type': 'application/json',
      },
      data: {}, // Empty body for POST request
    };

    // Send the request to download and store the plugin
    const downloadResponse = await axios(requestData);

    // Check the response and return appropriate status
    if (downloadResponse.status === 200) {
      return res.redirect(`/instance/${id}/plugins?success=true`);
    } else {
      return res.status(500).json({ success: false, message: "Error downloading plugin." });
    }
  } catch (error) {
    console.error('Error during plugin download:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: "An error occurred while processing your request." });
  }
});



module.exports = router;
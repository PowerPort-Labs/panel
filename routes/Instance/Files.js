const express = require('express');
const router = express.Router();
const { db } = require('../../handlers/db.js');
const { isUserAuthorizedForContainer } = require('../../utils/authHelper');
const { fetchFiles, FetchTotalContainerDisk } = require('../../utils/fileHelper');

const { loadPlugins } = require('../../plugins/loadPls.js');
const path = require('path');

const plugins = loadPlugins(path.join(__dirname, '../../plugins'));

function parseDiskUsage(size) {
    const unit = size.slice(-1); // Get the last character (M, G, etc.)
    const value = parseFloat(size.slice(0, -1)); // Get the numerical part

    if (isNaN(value)) return 0;

    switch (unit.toUpperCase()) {
        case "G":
            return value * 1024; 
        case "M":
            return value; 
        default:
            return 0; 
    }
}

router.get("/instance/:id/files", async (req, res) => {
    if (!req.user) return res.redirect('/');

    const { id } = req.params;
    if (!id) return res.redirect('../instances');

    const instance = await db.get(id + '_instance').catch(err => {
        console.error('Failed to fetch instance:', err);
        return null;
    });

    if (!instance || !instance.VolumeId) return res.redirect('../instances');

    const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
    if (!isAuthorized) {
        return res.status(403).send('Unauthorized access to this instance.');
    }


    if(instance.suspended === true) {
        return res.redirect('../../instances?err=SUSPENDED');
   }

    if(instance.suspended === true) {
                return res.redirect('../../instance/' + id + '/suspended');
    }

    const allPluginData = Object.values(plugins).map(plugin => plugin.config);

    try {
        const files = await fetchFiles(instance, req.query.path);
        /* Disk Usage Checkup */
        const checkusage = await FetchTotalContainerDisk(instance);
        const totalSpace = checkusage.totalSpace;
        const totaldiskusage = parseDiskUsage(totalSpace);
         // Default disk size in GB, converted to MB
        const totalInstanceDiskGB = instance.Disk || 10; // Default to 10GB if not provided
        const totalInstanceDiskMB = totalInstanceDiskGB * 1024; // Convert GB to MB
        /* $DEBUG$ console.log(totalInstanceDiskMB) */
        /* Ends here */
        if (totaldiskusage === 0) {}

        if (totaldiskusage > totalInstanceDiskMB) {
            return res.redirect(`../../instances?err=DISKLIMITEXCEEDED`);
        }
        res.render('instance/files', { 
            req, 
            totaldiskusage,
            files: files, 
            user: req.user, 
            instance,
            name: await db.get('name') || 'PowerPort', 
            logo: await db.get('logo') || false ,
            addons: {
                plugins: allPluginData
            }
        });
    } catch (error) {
        const errorMessage = error.response && error.response.data ? error.response.data.message : 'Connection to node failed.';
        res.status(500).render('500', { 
            error: errorMessage, 
            req, 
            instance,
            user: req.user, 
            name: await db.get('name') || 'PowerPort', 
            logo: await db.get('logo') || false,
            addons: {
                plugins: allPluginData
            }
        });
        console.log(error)
    }
});

module.exports = router;

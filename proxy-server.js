require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');
    next();
});
app.use(express.static(__dirname));

// Serve Demo.html at /demo route
app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, 'Demo.html'));
});

const JIRA_CONFIG = {
    baseUrl: 'https://lumen.atlassian.net/',
    username: 'Zuha.Mujawar@lumen.com',
    apiToken: process.env.JIRA_API_TOKEN || 'YOUR_JIRA_API_TOKEN_HERE'
};

// Dashboard expects /search endpoint with JQL query parameter
app.get('/search', async (req, res) => {
    try {
        const jql = req.query.jql;
        if (!jql) {
            return res.status(400).json({ error: 'JQL query parameter is required' });
        }
        
        console.log('Received JQL search request:', jql);
        
        const response = await axios.post(
            `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
            {
                jql: jql,
                maxResults: 100,
                fields: ['key', 'summary', 'status', 'assignee', 'reporter', 'issuetype', 'description', 'customfield_10014', 'issuelinks', 'fixVersions', 'versions', 'customfield_10004', 'customfield_10005', 'customfield_10006', 'customfield_10007', 'customfield_10008', 'customfield_10009', 'customfield_10010', 'customfield_10011', 'customfield_10012', 'customfield_10013', 'customfield_10015', 'customfield_10016', 'customfield_10017', 'customfield_10018', 'customfield_10019', 'customfield_10020', 'customfield_10021', 'customfield_10022', 'customfield_10023', 'customfield_10024', 'customfield_10025', 'customfield_10026', 'customfield_10027', 'customfield_10028', 'customfield_10029', 'customfield_10030', 'customfield_10056', 'customfield_10221', 'parent']
            },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('JIRA API Response received, issues count:', response.data.issues?.length || 0);
        res.json(response.data);
    } catch (error) {
        console.error('JIRA API Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

// Dashboard expects /issue/:key endpoint for individual issues
app.get('/issue/:key', async (req, res) => {
    try {
        const issueKey = req.params.key;
        console.log('Fetching issue details for:', issueKey);
        
        const response = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/api/3/issue/${issueKey}`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json'
                },
                params: {
                    expand: 'renderedFields',
                    fields: '*all'
                }
            }
        );
        
        console.log('Issue details received for:', issueKey);
        console.log('Available fields:', Object.keys(response.data.fields || {}));
        console.log('Rendered fields:', Object.keys(response.data.renderedFields || {}));
        
        res.json(response.data);
    } catch (error) {
        console.error('Issue API Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

app.post('/api/jira/search', async (req, res) => {
    try {
        console.log('Received search request:', req.body);
        
        const response = await axios.post(
            `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
            req.body,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('JIRA API Response received, issues count:', response.data.issues?.length || 0);
        res.json(response.data);
    } catch (error) {
        console.error('JIRA API Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

// Get available fix versions for autocomplete
app.get('/fixversions', async (req, res) => {
    try {
        const projectKey = req.query.project || 'CTL-Fix';
        console.log('Fetching fix versions for project:', projectKey);
        
        const response = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/api/3/project/${projectKey}/versions`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        const versions = response.data.map(version => ({
            id: version.id,
            name: version.name,
            description: version.description || '',
            released: version.released || false
        })).sort((a, b) => a.name.localeCompare(b.name));
        
        console.log('Fix versions received:', versions.length);
        res.json(versions);
    } catch (error) {
        console.error('Fix versions API Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

app.get('/api/jira/field-metadata', async (req, res) => {
    try {
        console.log('Fetching field metadata...');
        
        const response = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/api/3/field`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        console.log('Field metadata received, fields count:', response.data?.length || 0);
        res.json(response.data);
    } catch (error) {
        console.error('Field metadata API Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

app.listen(3000, () => {
    console.log('JIRA Proxy Server running on http://localhost:3000');
    console.log('Make sure to update dashboard.html to use this proxy URL');
});
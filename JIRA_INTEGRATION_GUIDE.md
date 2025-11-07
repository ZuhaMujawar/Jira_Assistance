# JIRA Integration Setup Guide

## Step 1: Get Your JIRA API Token

1. **Log in to your JIRA account** (https://your-organization.atlassian.net)
2. **Go to Account Settings** → Click on your profile picture → Account Settings
3. **Create API Token** → Security → Create and manage API tokens → Create API token
4. **Copy the token** - You'll need this for the configuration

## Step 2: Configure the Application

Open `dashboard.html` and update the `JIRA_CONFIG` object with your organization's details:

```javascript
const JIRA_CONFIG = {
    baseUrl: 'https://lumen.atlassian.net/', // Replace with your JIRA instance URL
    username: 'zuha.mujawar@lumen.com', // Replace with your JIRA login email
    apiToken: 'ATATT3xFfGF05OHsAF-i818WdLc-', // Replace with the API token from Step 1
};
```

## Step 3: CORS Configuration (Important!)

Since this is a client-side application, you may encounter CORS (Cross-Origin Resource Sharing) issues when connecting to JIRA from a browser. Here are solutions:

### Option A: Use a Proxy Server (Recommended)
Create a simple proxy server to handle JIRA API calls:

1. **Create `proxy-server.js`:**
```javascript
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

const JIRA_CONFIG = {
    baseUrl: 'https://lumen.atlassian.net/',
    username: 'zuha.mujawar@lumen.com',
    apiToken: 'ATATT3xFfGF05OHsAF-i818WdLc-'
};

app.post('/api/jira/search', async (req, res) => {
    try {
        const response = await axios.post(
            `${JIRA_CONFIG.baseUrl}/rest/api/3/search`,
            req.body,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(3000, () => {
    console.log('JIRA Proxy Server running on http://localhost:3000');
});
```

2. **Install dependencies:**
```bash
npm init -y
npm install express cors axios
node proxy-server.js
```

3. **Update dashboard.html to use proxy:**
```javascript
// Replace the fetch URL in searchJIRAIssues function
const response = await fetch('http://localhost:3000/api/jira/search', {
    method: 'POST',
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        jql: jqlQuery,
        maxResults: 50,
        fields: [
            'summary', 'status', 'priority', 'issuetype', 
            'assignee', 'reporter', 'created', 'updated'
        ]
    })
});
```

### Option B: Browser Extension (Development Only)
Install a CORS browser extension for development:
- Chrome: "CORS Unblock" extension
- Firefox: "CORS Everywhere" extension

**⚠️ Warning: Only use this for development, not production!**

### Option C: Deploy as Server-Side Application
Convert this to a Node.js/PHP/Python web application instead of client-side HTML.

## Step 4: Advanced Search Options

You can customize the JQL (JIRA Query Language) for more specific searches:

```javascript
// Examples of JQL queries you can use:
const jqlExamples = {
    basicText: `text ~ "${query}"`,
    projectSpecific: `project = "LUMEN" AND text ~ "${query}"`,
    statusFilter: `status = "In Progress" AND text ~ "${query}"`,
    assignedToMe: `assignee = currentUser() AND text ~ "${query}"`,
    recentIssues: `created >= -30d AND text ~ "${query}"`,
    priorityFilter: `priority in (High, Critical) AND text ~ "${query}"`
};
```

## Step 5: Security Considerations

### For Production Deployment:
1. **Never expose API tokens in client-side code**
2. **Use environment variables for sensitive data**
3. **Implement proper authentication and authorization**
4. **Consider using OAuth 2.0 instead of API tokens**
5. **Deploy with HTTPS**

### Recommended Architecture:
```
Browser → Your Web Server → JIRA API
         (Handles auth)    (Secure)
```

## Step 6: Testing

1. **Test with demo data first** - The app will show demo data if JIRA connection fails
2. **Check browser console** for any error messages
3. **Verify JIRA permissions** - Make sure your account can access the projects you want to search
4. **Test different search queries** to ensure results are returned correctly

## Step 7: Customization Options

### Add More Fields:
```javascript
fields: [
    'summary', 'status', 'priority', 'issuetype', 
    'assignee', 'reporter', 'created', 'updated',
    'components', 'fixVersions', 'labels', 'environment'
]
```

### Custom Filters:
You can add dropdown filters back by modifying the JQL query based on user selections.

### Pagination:
Add pagination for large result sets by implementing `startAt` and `maxResults` parameters.

## Troubleshooting

### Common Issues:
1. **CORS Error**: Use proxy server (Option A above)
2. **401 Unauthorized**: Check API token and username
3. **403 Forbidden**: Verify JIRA permissions
4. **No Results**: Check JQL query syntax and project permissions

### Debug Mode:
Add this to see detailed API responses:
```javascript
console.log('JIRA Response:', data);
console.log('Processed Results:', results);
```

## Support

If you need help with the integration:
1. Check JIRA API documentation: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
2. Test API calls using tools like Postman first
3. Verify your JIRA instance URL and permissions
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { randomUUID } = require('crypto');
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

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const JOB_TTL_MS = 30 * 60 * 1000;   // 30 minutes retention for job inspection
const MAX_CONCURRENT_JOBS = 2;
const ISSUE_CHUNK_SIZE = 25;

const asyncJobs = new Map();
const cacheStore = new Map();
const pendingQueue = [];
let activeJobCount = 0;

function computeCacheKey(jql, fields, maxResults, startAt, nextPageToken) {
    const normalizedFields = Array.from(new Set(fields)).sort();
    return JSON.stringify({
        jql,
        fields: normalizedFields,
        maxResults,
        startAt: Number.isFinite(startAt) ? startAt : 0,
        nextPageToken: nextPageToken || null
    });
}

function getCacheEntry(cacheKey) {
    const entry = cacheStore.get(cacheKey);
    if (!entry) {
        return null;
    }
    if (Date.now() > entry.expiresAt) {
        cacheStore.delete(cacheKey);
        return null;
    }
    return entry;
}

function setCacheEntry(cacheKey, data) {
    cacheStore.set(cacheKey, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

function deriveResultMeta(job, payload) {
    const issuesCount = Array.isArray(payload?.issues) ? payload.issues.length : 0;
    const startAt = Number.isFinite(payload?.startAt)
        ? payload.startAt
        : (Number.isFinite(job?.request?.startAt) ? job.request.startAt : 0);
    const total = Number.isFinite(payload?.total)
        ? payload.total
        : Math.max(issuesCount + startAt, issuesCount);
    const maxResults = Number.isFinite(payload?.maxResults)
        ? payload.maxResults
        : (job?.request?.maxResults || issuesCount);
    const nextPageToken = typeof payload?.nextPageToken === 'string' && payload.nextPageToken.length > 0
        ? payload.nextPageToken
        : null;
    const nextStartAt = startAt + issuesCount;
    const explicitHasMore = typeof payload?.isLast === 'boolean'
        ? !payload.isLast
        : undefined;
    const hasMore = typeof explicitHasMore === 'boolean'
        ? explicitHasMore
        : (nextPageToken ? true : nextStartAt < total);

    return {
        total,
        startAt,
        maxResults,
        pageSize: issuesCount,
        nextStartAt,
        nextPageToken,
        hasMore
    };
}

function broadcastJobEvent(job, payload) {
    const serialized = `data: ${JSON.stringify(payload)}\n\n`;
    job.eventHistory.push(serialized);
    for (const client of job.streamClients) {
        try {
            client.res.write(serialized);
        } catch (error) {
            console.warn('Stream write failed, removing client:', error.message);
            job.streamClients.delete(client);
        }
    }
}

async function performJiraSearch(jql, fields, maxResults, startAt = 0, nextPageToken = null) {
    const normalizedFields = Array.isArray(fields) ? fields.filter(Boolean) : [];
    const searchPayload = {
        jql,
        maxResults,
        fields: normalizedFields,
        fieldsByKeys: false
    };

    if (!nextPageToken && Number.isFinite(startAt) && startAt > 0) {
        searchPayload.startAt = startAt;
    }

    if (typeof nextPageToken === 'string' && nextPageToken.length > 0) {
        searchPayload.nextPageToken = nextPageToken;
    }

    const response = await axios.post(
        `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
        searchPayload,
        {
            headers: {
                'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-ExperimentalApi': 'opt-in'
            }
        }
    );

    const jiraPayload = response.data || {};
    const issues = Array.isArray(jiraPayload.issues) ? jiraPayload.issues : [];

    return {
        issues,
        startAt: Number.isFinite(jiraPayload.startAt) ? jiraPayload.startAt : startAt,
        maxResults: Number.isFinite(jiraPayload.maxResults) ? jiraPayload.maxResults : maxResults,
        total: Number.isFinite(jiraPayload.total)
            ? jiraPayload.total
            : issues.length + (Number.isFinite(startAt) ? startAt : 0),
        nextPageToken: typeof jiraPayload.nextPageToken === 'string' ? jiraPayload.nextPageToken : null,
        isLast: typeof jiraPayload.isLast === 'boolean' ? jiraPayload.isLast : undefined,
        names: jiraPayload.names || {},
        schema: jiraPayload.schema || {},
        warnings: Array.isArray(jiraPayload.warningMessages) ? jiraPayload.warningMessages : []
    };
}

function finalizeJob(job, status, payload) {
    job.status = status;
    job.updatedAt = Date.now();
    if (status === 'complete') {
        job.result = payload;
        job.resultMeta = deriveResultMeta(job, payload);
        setCacheEntry(job.cacheKey, payload);
        broadcastJobEvent(job, {
            requestId: job.id,
            type: 'complete',
            status: 'complete',
            totalIssues: job.resultMeta.pageSize,
            meta: job.resultMeta,
            complete: true,
            data: payload
        });
    } else if (status === 'error') {
        job.error = payload;
        broadcastJobEvent(job, {
            requestId: job.id,
            type: 'error',
            status: 'error',
            message: payload.message || 'Unknown error',
            complete: true
        });
    }
    activeJobCount = Math.max(0, activeJobCount - 1);
    processPendingQueue();
}

async function processJob(job) {
    try {
        job.status = 'processing';
        job.updatedAt = Date.now();
        broadcastJobEvent(job, {
            requestId: job.id,
            type: 'status',
            status: 'processing',
            message: 'Fetching issues from Jira',
            complete: false
        });

        const jiraData = await performJiraSearch(
            job.request.jql,
            job.request.fields,
            job.request.maxResults,
            job.request.startAt,
            job.request.nextPageToken
        );
        const issues = Array.isArray(jiraData.issues) ? jiraData.issues : [];

        for (let index = 0; index < issues.length; index += ISSUE_CHUNK_SIZE) {
            const chunk = issues.slice(index, index + ISSUE_CHUNK_SIZE);
            job.collectedIssues.push(...chunk);
            const sequence = job.chunks.length + 1;
            job.chunks.push(chunk);
            broadcastJobEvent(job, {
                requestId: job.id,
                type: 'issuesChunk',
                sequence,
                chunk,
                remaining: Math.max(issues.length - (index + ISSUE_CHUNK_SIZE), 0),
                complete: false
            });
        }

        finalizeJob(job, 'complete', jiraData);
    } catch (error) {
        console.error('Async job failed:', error.response?.data || error.message);
        finalizeJob(job, 'error', {
            message: error.message,
            details: error.response?.data || null
        });
    }
}

function processPendingQueue() {
    if (activeJobCount >= MAX_CONCURRENT_JOBS) {
        return;
    }

    const nextJob = pendingQueue.shift();
    if (!nextJob) {
        return;
    }

    activeJobCount += 1;
    processJob(nextJob).catch(error => {
        console.error('Unexpected job processing error:', error);
        finalizeJob(nextJob, 'error', { message: error.message });
    });
}

function enqueueJob(job) {
    pendingQueue.push(job);
    processPendingQueue();
}

function registerStreamClient(job, res) {
    const client = { res };
    job.streamClients.add(client);
    res.on('close', () => {
        job.streamClients.delete(client);
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [requestId, job] of asyncJobs.entries()) {
        if (now - job.updatedAt > JOB_TTL_MS && job.streamClients.size === 0) {
            asyncJobs.delete(requestId);
        }
    }
    for (const [cacheKey, entry] of cacheStore.entries()) {
        if (now > entry.expiresAt) {
            cacheStore.delete(cacheKey);
        }
    }
}, 60 * 1000);

const BASE_SEARCH_FIELDS = [
    'key',
    'summary',
    'status',
    'assignee',
    'reporter',
    'issuetype',
    'description',
    'customfield_10014',
    'issuelinks',
    'fixVersions',
    'versions',
    'customfield_10004',
    'customfield_10005',
    'customfield_10006',
    'customfield_10007',
    'customfield_10008',
    'customfield_10009',
    'customfield_10010',
    'customfield_10011',
    'customfield_10012',
    'customfield_10013',
    'customfield_10015',
    'customfield_10016',
    'customfield_10017',
    'customfield_10018',
    'customfield_10019',
    'customfield_10020',
    'customfield_10021',
    'customfield_10022',
    'customfield_10023',
    'customfield_10024',
    'customfield_10025',
    'customfield_10026',
    'customfield_10027',
    'customfield_10028',
    'customfield_10029',
    'customfield_10030',
    'customfield_10056',
    'customfield_10221',
    'parent'
];

app.post('/async/search', (req, res) => {
    try {
        const jql = req.body?.jql;
        if (!jql || typeof jql !== 'string' || jql.trim().length === 0) {
            return res.status(400).json({ error: 'jql is required for async search' });
        }

        const includeFields = req.body?.includeFields;
        const requestedMaxResults = Number.parseInt(req.body?.maxResults, 10);
        const maxResults = Number.isFinite(requestedMaxResults) && requestedMaxResults > 0
            ? Math.min(requestedMaxResults, 250)
            : 100;
        const requestedStartAt = Number.parseInt(req.body?.startAt, 10);
        const startAt = Number.isFinite(requestedStartAt) && requestedStartAt >= 0
            ? requestedStartAt
            : 0;
        const nextPageToken = typeof req.body?.nextPageToken === 'string' && req.body.nextPageToken.trim().length > 0
            ? req.body.nextPageToken.trim()
            : null;

        const fieldsToRequest = new Set(BASE_SEARCH_FIELDS);

        if (Array.isArray(includeFields)) {
            includeFields
                .map(field => field && field.trim())
                .filter(Boolean)
                .forEach(field => fieldsToRequest.add(field));
        } else if (typeof includeFields === 'string') {
            includeFields
                .split(',')
                .map(field => field && field.trim())
                .filter(Boolean)
                .forEach(field => fieldsToRequest.add(field));
        }

        const normalizedFields = Array.from(fieldsToRequest);
        const cacheKey = computeCacheKey(jql, normalizedFields, maxResults, startAt, nextPageToken);
        const cached = getCacheEntry(cacheKey);
        const requestId = randomUUID();
        const job = {
            id: requestId,
            status: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            request: {
                jql,
                fields: normalizedFields,
                maxResults,
                startAt,
                nextPageToken
            },
            cacheKey,
            result: null,
            error: null,
            chunks: [],
            collectedIssues: [],
            streamClients: new Set(),
            eventHistory: [],
            resultMeta: null
        };

        asyncJobs.set(requestId, job);

        const responseLinks = {
            requestId,
            pollUrl: `/async/search/${requestId}`,
            streamUrl: `/async/search/${requestId}/stream`
        };

        if (cached) {
            job.status = 'complete';
            job.result = cached.data;
            job.collectedIssues = Array.isArray(cached.data?.issues) ? [...cached.data.issues] : [];
            job.resultMeta = deriveResultMeta(job, cached.data);
            job.eventHistory.push(`data: ${JSON.stringify({
                requestId,
                type: 'complete',
                status: 'complete',
                totalIssues: job.resultMeta.pageSize,
                complete: true,
                data: cached.data,
                meta: job.resultMeta,
                cacheHit: true
            })}\n\n`);
            return res.status(200).json({
                ...responseLinks,
                status: 'complete',
                cacheHit: true,
                data: cached.data,
                meta: job.resultMeta
            });
        }

        enqueueJob(job);

        res.status(202).json({
            ...responseLinks,
            status: 'pending',
            cacheHit: false,
            etaMs: 900
        });
    } catch (error) {
        console.error('Failed to enqueue async search:', error);
        res.status(500).json({ error: 'Unable to start async search', details: error.message });
    }
});

app.get('/async/search/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const job = asyncJobs.get(requestId);

    if (!job) {
        return res.status(404).json({ error: 'Request not found' });
    }

    const basePayload = {
        requestId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        pollUrl: `/async/search/${requestId}`,
        streamUrl: `/async/search/${requestId}/stream`
    };

    if (job.status === 'complete') {
        return res.json({
            ...basePayload,
            data: job.result,
            totalIssues: job.resultMeta?.pageSize || job.result?.issues?.length || 0,
            meta: job.resultMeta
        });
    }

    if (job.status === 'error') {
        return res.status(500).json({
            ...basePayload,
            error: job.error || { message: 'Unknown processing error' }
        });
    }

    res.json({
        ...basePayload,
        collectedIssues: job.collectedIssues,
        collectedCount: job.collectedIssues.length,
        pendingChunks: Math.max(job.request.maxResults - job.collectedIssues.length, 0)
    });
});

app.get('/async/search/:requestId/stream', (req, res) => {
    const requestId = req.params.requestId;
    const job = asyncJobs.get(requestId);

    if (!job) {
        res.writeHead(404, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'close'
        });
        res.write(`data: ${JSON.stringify({
            requestId,
            type: 'error',
            status: 'error',
            message: 'Request not found',
            complete: true
        })}\n\n`);
        return res.end();
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    registerStreamClient(job, res);

    for (const event of job.eventHistory) {
        res.write(event);
    }

    if (job.status === 'complete' || job.status === 'error') {
        res.end();
    }
});

// Dashboard expects /search endpoint with JQL query parameter
app.get('/search', async (req, res) => {
    try {
        const jql = req.query.jql;
        if (!jql) {
            return res.status(400).json({ error: 'JQL query parameter is required' });
        }
        
        console.log('Received JQL search request:', jql);
        const includeFieldsParam = req.query.includeFields;
        const fieldsToRequest = [...BASE_SEARCH_FIELDS];

        const requestedMaxResults = Number.parseInt(req.query.maxResults, 10);
        const maxResults = Number.isFinite(requestedMaxResults) && requestedMaxResults > 0
            ? Math.min(requestedMaxResults, 100)
            : 100;

        if (includeFieldsParam) {
            const extraFields = Array.isArray(includeFieldsParam)
                ? includeFieldsParam
                : includeFieldsParam.split(',');

            extraFields
                .map(field => field && field.trim())
                .filter(Boolean)
                .forEach(field => {
                    if (!fieldsToRequest.includes(field)) {
                        fieldsToRequest.push(field);
                    }
                });
        }

        console.log('Fields requested from JIRA:', fieldsToRequest);
        
        const requestedStartAt = Number.parseInt(req.query.startAt, 10);
        const startAt = Number.isFinite(requestedStartAt) && requestedStartAt >= 0
            ? requestedStartAt
            : 0;

        const nextPageToken = typeof req.query.nextPageToken === 'string' && req.query.nextPageToken.trim().length > 0
            ? req.query.nextPageToken.trim()
            : null;

        const jiraData = await performJiraSearch(jql, fieldsToRequest, maxResults, startAt, nextPageToken);

        console.log('JIRA API Response received, issues count:', jiraData.issues?.length || 0);
        res.json(jiraData);
    } catch (error) {
        const statusCode = error.response?.status || 500;
        console.error('JIRA API Error:', error.response?.data || error.message);
        res.status(statusCode).json({ 
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
        const requestedFields = req.query.fields;
        const expandOverride = req.query.expand;

        let fieldsParam = '*all';
        if (Array.isArray(requestedFields)) {
            fieldsParam = requestedFields.filter(Boolean).join(',');
        } else if (requestedFields) {
            fieldsParam = requestedFields;
        }

        const params = {
            fields: fieldsParam
        };

        if (expandOverride) {
            params.expand = expandOverride;
        } else if (!requestedFields) {
            params.expand = 'renderedFields';
        }
        
        const response = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/api/3/issue/${issueKey}`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json'
                },
                params
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

app.get('/agile/issue/:key', async (req, res) => {
    try {
        const issueKey = req.params.key;
        console.log('Fetching agile issue details for:', issueKey);

        const params = {};
        if (req.query.expand) {
            params.expand = req.query.expand;
        }
        if (req.query.fields) {
            params.fields = req.query.fields;
        }

        const response = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/agile/1.0/issue/${issueKey}`,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json'
                },
                params
            }
        );

        res.json(response.data);
    } catch (error) {
        console.error('Agile issue API Error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

app.post('/api/jira/search', async (req, res) => {
    try {
        console.log('Received search request:', req.body);
        
        const response = await axios.post(
            `${JIRA_CONFIG.baseUrl}rest/api/3/search`,
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

// Email sending endpoint
app.post('/send-emails', async (req, res) => {
    try {
        console.log('📧 Received email sending request');
        const { emailsData } = req.body;
        
        if (!emailsData || !Array.isArray(emailsData)) {
            return res.status(400).json({ error: 'Invalid emails data' });
        }
        
        console.log(`📧 Processing ${emailsData.length} emails for sending`);
        
        // Import email sending module
        const { sendEmailsViaOutlook } = require('./send-emails.js');
        
        // Send emails
        const result = await sendEmailsViaOutlook(emailsData);
        
        console.log('📊 Email sending result:', result);
        
        res.json({
            success: true,
            result: result,
            message: `Email sending completed. Success: ${result.success}, Failed: ${result.failure}`
        });
        
    } catch (error) {
        console.error('❌ Email sending error:', error);
        res.status(500).json({
            error: 'Email sending failed',
            details: error.message
        });
    }
});

app.listen(3000, () => {
    console.log('JIRA Proxy Server running on http://localhost:3000');
    console.log('Make sure to update dashboard.html to use this proxy URL');
});
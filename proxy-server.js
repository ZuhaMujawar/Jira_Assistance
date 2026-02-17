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

const DEFAULT_TESTCASE_ISSUE_TYPE = process.env.JIRA_TESTCASE_ISSUE_TYPE || 'Test';
const DEFAULT_TESTCASE_LINK_TYPE = process.env.JIRA_TESTCASE_LINK_TYPE || 'Relates';

function getJiraAuthHeaders(extra = {}) {
    return {
        'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
        'Accept': 'application/json',
        ...extra
    };
}

function decodeHtmlEntities(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }
    return text
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&nbsp;/gi, ' ');
}

function stripHtmlTags(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return decodeHtmlEntities(
        value
            .replace(/<\s*br\s*\/?\s*>/gi, '\n')
            .replace(/<\/(p|div|h[1-6])>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n- ')
            .replace(/<[^>]+>/g, '')
    )
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function flattenAdfToText(node, indent = '') {
    if (!node) {
        return '';
    }
    if (Array.isArray(node)) {
        return node.map(child => flattenAdfToText(child, indent)).join('');
    }
    if (node.type === 'text') {
        return node.text || '';
    }
    if (node.type === 'hardBreak') {
        return '\n';
    }
    if (node.type === 'paragraph') {
        return flattenAdfToText(node.content, indent) + '\n';
    }
    if (node.type === 'bulletList') {
        return node.content
            .map(item => indent + '- ' + flattenAdfToText(item, indent + '  ').trim() + '\n')
            .join('');
    }
    if (node.type === 'orderedList') {
        return node.content
            .map((item, index) => indent + (index + 1) + '. ' + flattenAdfToText(item, indent + '  ').trim() + '\n')
            .join('');
    }
    if (node.type === 'listItem') {
        return flattenAdfToText(node.content, indent);
    }
    if (node.content) {
        return flattenAdfToText(node.content, indent);
    }
    return '';
}

function normalizeRichTextField(field) {
    if (!field) {
        return '';
    }
    if (typeof field === 'string') {
        return stripHtmlTags(field);
    }
    if (field.type === 'doc' && Array.isArray(field.content)) {
        return stripHtmlTags(flattenAdfToText(field.content));
    }
    if (Array.isArray(field)) {
        return stripHtmlTags(field.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'));
    }
    if (typeof field === 'object') {
        return stripHtmlTags(JSON.stringify(field));
    }
    return stripHtmlTags(String(field));
}

function extractListItems(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }
    return text
        .split(/\r?\n|(?<=\.)\s+(?=[A-Z])/)
        .map(line => line.replace(/^\s*[-*•]\s*/, '').replace(/^\s*\d+\.\s*/, '').trim())
        .filter(Boolean);
}

function dedupeList(items) {
    const seen = new Set();
    const result = [];
    items.forEach(item => {
        const key = item.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    });
    return result;
}

function buildTestCasePlan(story, acceptanceText, descriptionText) {
    const summary = story?.fields?.summary ? story.fields.summary.trim() : story.key;
    const acceptanceItems = dedupeList(extractListItems(acceptanceText));
    const descriptionItems = dedupeList(extractListItems(descriptionText));
    const stepsSource = acceptanceItems.length ? acceptanceItems : descriptionItems;
    const steps = stepsSource.length
        ? stepsSource
        : [`Execute the end-to-end validation aligned with story ${story.key}.`];
    const expected = acceptanceItems.length
        ? acceptanceItems
        : [`Outcome aligns with the acceptance criteria for ${story.key}.`];

    const descriptionLines = [
        `Story: ${story.key} – ${summary}`,
        '',
        'Test Objectives:',
        `- Validate that the solution satisfies the acceptance criteria of ${story.key}.`,
        '',
        'Test Steps:',
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        '',
        'Expected Results:',
        ...expected.map(item => `- ${item}`)
    ];

    if (acceptanceText && acceptanceText.trim().length > 0) {
        descriptionLines.push('');
        descriptionLines.push('Acceptance Criteria Reference:');
        acceptanceText
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .forEach(line => descriptionLines.push(`- ${line.replace(/^[-*•]\s*/, '')}`));
    }

    descriptionLines.push('');
    descriptionLines.push('Notes:');
    descriptionLines.push('- Generated automatically by Feature Lifecycle Navigator. Adjust the steps as needed.');

    return {
        description: descriptionLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        steps,
        expected
    };
}

async function resolveTestCaseIssueType(projectKey, preferredName) {
    const fallbackName = preferredName || DEFAULT_TESTCASE_ISSUE_TYPE || 'Test';
    try {
        const response = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/api/3/issue/createmeta`,
            {
                headers: getJiraAuthHeaders(),
                params: {
                    projectKeys: projectKey,
                    expand: 'projects.issuetypes.fields'
                }
            }
        );

        const projects = Array.isArray(response?.data?.projects) ? response.data.projects : [];
        if (!projects.length) {
            return { name: fallbackName };
        }

        const project = projects.find(p => p.key === projectKey) || projects[0];
        const issueTypes = Array.isArray(project?.issuetypes) ? project.issuetypes : [];
        if (!issueTypes.length) {
            return { name: fallbackName };
        }

        const preferred = issueTypes.find(type => type.name.toLowerCase() === fallbackName.toLowerCase());
        if (preferred) {
            return { id: preferred.id, name: preferred.name };
        }

        const testLike = issueTypes.find(type => /test/.test(type.name.toLowerCase()));
        if (testLike) {
            return { id: testLike.id, name: testLike.name };
        }

        return { name: fallbackName };
    } catch (error) {
        console.warn('Unable to resolve test case issue types, falling back to configured name.', error.response?.data || error.message);
        return { name: fallbackName };
    }
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const JOB_TTL_MS = 30 * 60 * 1000;   // 30 minutes retention for job inspection
const MAX_CONCURRENT_JOBS = 2;
const ISSUE_CHUNK_SIZE = 25;

const asyncJobs = new Map();
const cacheStore = new Map();
const pendingQueue = [];
let activeJobCount = 0;

const apiSearchCache = new Map();

function getApiSearchCache(cacheKey) {
    const entry = apiSearchCache.get(cacheKey);
    if (!entry) {
        return null;
    }
    if (Date.now() > entry.expiresAt) {
        apiSearchCache.delete(cacheKey);
        return null;
    }
    return entry.data;
}

function setApiSearchCache(cacheKey, data, ttlMs = CACHE_TTL_MS) {
    apiSearchCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + ttlMs
    });
}

function convertPlainTextToADF(input) {
    const normalized = typeof input === 'string' ? input.replace(/\r\n/g, '\n') : '';
    const lines = normalized.split('\n');
    const content = lines.map(line => {
        const trimmedLine = line.replace(/\s+$/g, '');
        if (!trimmedLine) {
            return { type: 'paragraph', content: [] };
        }
        return {
            type: 'paragraph',
            content: [
                {
                    type: 'text',
                    text: trimmedLine
                }
            ]
        };
    });

    if (!content.length) {
        content.push({ type: 'paragraph', content: [] });
    }

    return {
        type: 'doc',
        version: 1,
        content
    };
}

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
        : (Number.isFinite(job?.request?.total) ? job.request.total : undefined);
    const maxResults = Number.isFinite(payload?.maxResults)
        ? payload.maxResults
        : (job?.request?.maxResults || issuesCount);
    const nextPageToken = typeof payload?.nextPageToken === 'string' && payload.nextPageToken.length > 0
        ? payload.nextPageToken
        : null;
    const nextStartAt = Number.isFinite(startAt) ? startAt + issuesCount : issuesCount;
    const isLast = typeof payload?.isLast === 'boolean'
        ? payload.isLast
        : undefined;
    const hasMore = typeof payload?.hasMore === 'boolean'
        ? payload.hasMore
        : (typeof isLast === 'boolean'
            ? !isLast
            : Boolean(nextPageToken));
    const computedTotal = Number.isFinite(total)
        ? total
        : nextStartAt;

    return {
        total: computedTotal,
        startAt,
        maxResults,
        pageSize: issuesCount,
        nextStartAt,
        nextPageToken,
        isLast,
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
        maxResults
    };

    if (normalizedFields.length > 0) {
        searchPayload.fields = normalizedFields;
    }

    if (typeof nextPageToken === 'string' && nextPageToken.length > 0) {
        searchPayload.nextPageToken = nextPageToken;
    }

    const requestConfig = {
        headers: {
            'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-ExperimentalApi': 'opt-in'
        }
    };

    let response;
    try {
        response = await axios.post(
            `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
            searchPayload,
            requestConfig
        );
    } catch (error) {
        const message = JSON.stringify(error.response?.data || {});
        const canRetryWithoutFields = error.response?.status === 400 && normalizedFields.length > 0 && /Invalid request payload/i.test(message);
        if (!canRetryWithoutFields) {
            throw error;
        }
        const fallbackPayload = {
            jql,
            maxResults
        };
        if (typeof nextPageToken === 'string' && nextPageToken.length > 0) {
            fallbackPayload.nextPageToken = nextPageToken;
        }
        response = await axios.post(
            `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
            fallbackPayload,
            requestConfig
        );
    }

    const jiraPayload = response.data || {};
    const issues = Array.isArray(jiraPayload.issues) ? jiraPayload.issues : [];

    const fallbackStart = Number.isFinite(startAt) ? startAt : 0;
    const responseStart = Number.isFinite(jiraPayload.startAt) ? jiraPayload.startAt : fallbackStart;
    const responseTotal = Number.isFinite(jiraPayload.total)
        ? jiraPayload.total
        : issues.length + responseStart;

    return {
        issues,
        startAt: responseStart,
        maxResults: Number.isFinite(jiraPayload.maxResults) ? jiraPayload.maxResults : maxResults,
        total: responseTotal,
        nextPageToken: typeof jiraPayload.nextPageToken === 'string' ? jiraPayload.nextPageToken : null,
        isLast: typeof jiraPayload.isLast === 'boolean' ? jiraPayload.isLast : undefined,
        hasMore: typeof jiraPayload.isLast === 'boolean'
            ? !jiraPayload.isLast
            : (typeof jiraPayload.nextPageToken === 'string' && jiraPayload.nextPageToken.length > 0),
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
    for (const [cacheKey, entry] of apiSearchCache.entries()) {
        if (now > entry.expiresAt) {
            apiSearchCache.delete(cacheKey);
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
    'labels',
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

        const fieldsParam = req.body?.fields ?? req.body?.includeFields;
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

        if (Array.isArray(fieldsParam)) {
            fieldsParam
                .map(field => field && field.trim())
                .filter(Boolean)
                .forEach(field => fieldsToRequest.add(field));
        } else if (typeof fieldsParam === 'string') {
            fieldsParam
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
        const includeFieldsParam = req.query.fields ?? req.query.includeFields;
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

app.put('/issue/:key', async (req, res) => {
    try {
        const issueKey = req.params.key;
        const { description, acceptanceCriteria } = req.body || {};

        const fields = {};

        if (typeof description === 'string') {
            fields.description = convertPlainTextToADF(description);
        }

        if (typeof acceptanceCriteria === 'string') {
            fields['customfield_10056'] = acceptanceCriteria.trim().length > 0
                ? acceptanceCriteria
                : null;
        }

        if (Object.keys(fields).length === 0) {
            return res.status(400).json({ error: 'No updatable fields provided' });
        }

        await axios.put(
            `${JIRA_CONFIG.baseUrl}rest/api/3/issue/${issueKey}`,
            { fields },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({ success: true });
    } catch (error) {
        const status = error.response?.status || 500;
        console.error('Issue update error:', error.response?.data || error.message);
        res.status(status).json({
            error: error.message,
            details: error.response?.data || 'No additional details available'
        });
    }
});

app.post('/api/jira/testcases', async (req, res) => {
    const storyKeyInput = req.body?.storyKey;
    if (!storyKeyInput || typeof storyKeyInput !== 'string') {
        return res.status(400).json({ error: 'storyKey is required to generate test cases.' });
    }

    const storyKey = storyKeyInput.trim().toUpperCase();
    const assigneeStrategy = req.body?.assigneeStrategy || 'storyAssignee';
    const overrideAssignee = typeof req.body?.assigneeAccountId === 'string'
        ? req.body.assigneeAccountId.trim()
        : '';
    const issueTypeName = (req.body?.issueTypeName || DEFAULT_TESTCASE_ISSUE_TYPE || 'Test').trim();
    let resolvedIssueType = { name: issueTypeName };

    try {
        const storyResponse = await axios.get(
            `${JIRA_CONFIG.baseUrl}rest/api/3/issue/${encodeURIComponent(storyKey)}?expand=renderedFields`,
            {
                headers: getJiraAuthHeaders()
            }
        );

        const story = storyResponse.data;
        if (!story || !story.fields || !story.fields.project || !story.fields.project.key) {
            return res.status(400).json({ error: `Unable to resolve project information for ${storyKey}.` });
        }

        const acceptanceText = normalizeRichTextField(
            story.renderedFields?.customfield_10056 || story.fields?.customfield_10056
        );
        const descriptionText = normalizeRichTextField(
            story.renderedFields?.description || story.fields?.description
        );

        const testPlan = buildTestCasePlan(story, acceptanceText, descriptionText);
        const testCaseSummary = `Test cases for ${storyKey} – ${story.fields.summary || 'Story validation'}`;
        const projectKey = story.fields.project.key;

        resolvedIssueType = await resolveTestCaseIssueType(projectKey, issueTypeName);

        const createPayload = {
            fields: {
                project: { key: projectKey },
                summary: testCaseSummary,
                description: convertPlainTextToADF(testPlan.description),
                labels: Array.isArray(story.fields.labels)
                    ? Array.from(new Set([...story.fields.labels, 'auto-generated-testcase']))
                    : ['auto-generated-testcase']
            }
        };

        createPayload.fields.issuetype = {};
        if (resolvedIssueType.id) {
            createPayload.fields.issuetype.id = resolvedIssueType.id;
        }
        createPayload.fields.issuetype.name = resolvedIssueType.name || issueTypeName;

        if (assigneeStrategy === 'storyAssignee' && story.fields.assignee?.accountId) {
            createPayload.fields.assignee = { accountId: story.fields.assignee.accountId };
        } else if (overrideAssignee) {
            createPayload.fields.assignee = { accountId: overrideAssignee };
        }

        let createdIssueKey = null;
        let createError = null;

        try {
            const createResponse = await axios.post(
                `${JIRA_CONFIG.baseUrl}rest/api/3/issue`,
                createPayload,
                {
                    headers: getJiraAuthHeaders({ 'Content-Type': 'application/json' })
                }
            );
            createdIssueKey = createResponse?.data?.key || null;
        } catch (error) {
            createError = error;
        }

        if (!createdIssueKey) {
            const errorPayload = createError?.response?.data;
            const errorMessages = Array.isArray(errorPayload?.errorMessages)
                ? errorPayload.errorMessages.join(' ')
                : typeof errorPayload?.message === 'string'
                    ? errorPayload.message
                    : createError?.message || 'Unknown Jira error while creating the test case.';
            const status = createError?.response?.status || 500;

            let hint = '';
            if (status === 400 && (errorPayload?.errors?.issuetype || /issue type/i.test(errorMessages))) {
                hint = `Jira rejected the issue type "${resolvedIssueType.name}". Set JIRA_TESTCASE_ISSUE_TYPE to a valid type or update the chatbot configuration.`;
            }

            return res.status(status).json({
                error: errorMessages,
                details: errorPayload?.errors || null,
                issueTypeUsed: resolvedIssueType,
                hint: hint || undefined
            });
        }

        let linkCreated = false;
        try {
            await axios.post(
                `${JIRA_CONFIG.baseUrl}rest/api/3/issueLink`,
                {
                    type: { name: DEFAULT_TESTCASE_LINK_TYPE },
                    inwardIssue: { key: createdIssueKey },
                    outwardIssue: { key: storyKey }
                },
                {
                    headers: getJiraAuthHeaders({ 'Content-Type': 'application/json' })
                }
            );
            linkCreated = true;
        } catch (linkError) {
            console.warn('Failed to create Jira issue link:', linkError.response?.data || linkError.message);
        }

        const browseBase = JIRA_CONFIG.baseUrl.replace(/\/?$/, '');

        return res.json({
            success: true,
            testCaseKey: createdIssueKey,
            testCaseUrl: `${browseBase}/browse/${createdIssueKey}`,
            linked: linkCreated,
            storyKey,
            summary: testCaseSummary,
            steps: testPlan.steps,
            expectedResults: testPlan.expected,
            issueTypeUsed: resolvedIssueType
        });
    } catch (error) {
        console.error('Test case generation failed:', error.response?.data || error.message);
        const status = error?.response?.status || 500;

        if (status === 404) {
            return res.status(404).json({ error: `Story ${storyKey} was not found in Jira.`, issueTypeUsed: resolvedIssueType });
        }

        if (status === 401 || status === 403) {
            return res.status(status).json({
                error: 'Jira rejected the request. Verify credentials and permissions for creating issues.',
                issueTypeUsed: resolvedIssueType
            });
        }

        const jiraDetails = error?.response?.data;
        const message = Array.isArray(jiraDetails?.errorMessages) && jiraDetails.errorMessages.length
            ? jiraDetails.errorMessages.join(' ')
            : jiraDetails?.message || error.message || 'Unknown Jira error.';

        return res.status(status).json({
            error: message,
            details: jiraDetails?.errors || null,
            issueTypeUsed: resolvedIssueType
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
        const rawPayload = req.body && typeof req.body === 'object' ? req.body : {};
        const jql = typeof rawPayload.jql === 'string' ? rawPayload.jql.trim() : '';

        if (!jql) {
            return res.status(400).json({ error: 'jql is required' });
        }

        const requestedMaxResults = Number.parseInt(rawPayload.maxResults, 10);
        const maxResults = Number.isFinite(requestedMaxResults)
            ? Math.min(Math.max(requestedMaxResults, 1), 100)
            : 50;

        const requestedStartAt = Number.parseInt(rawPayload.startAt, 10);
        const startAt = Number.isFinite(requestedStartAt) && requestedStartAt >= 0 ? requestedStartAt : 0;

        const nextPageToken = typeof rawPayload.nextPageToken === 'string' && rawPayload.nextPageToken.trim().length > 0
            ? rawPayload.nextPageToken.trim()
            : null;

        const rawFields = rawPayload.fields ?? rawPayload.includeFields ?? [];
        const fieldsArray = Array.isArray(rawFields)
            ? rawFields
            : typeof rawFields === 'string'
                ? rawFields.split(',')
                : [];
        const normalizedFields = Array.from(new Set(
            fieldsArray
                .map(field => (field && field.toString ? field.toString().trim() : ''))
                .filter(Boolean)
        ));

        if (normalizedFields.length === 0) {
            normalizedFields.push('summary', 'status', 'assignee');
        }

        const cacheKey = computeCacheKey(jql, normalizedFields, maxResults, startAt, nextPageToken);
        const cached = getApiSearchCache(cacheKey);
        if (cached) {
            return res.json({ ...cached, cacheHit: true });
        }

        const payload = {
            jql,
            maxResults,
            fields: normalizedFields
        };

        if (nextPageToken) {
            payload.nextPageToken = nextPageToken;
        }

        const requestConfig = {
            headers: {
                'Authorization': `Basic ${Buffer.from(JIRA_CONFIG.username + ':' + JIRA_CONFIG.apiToken).toString('base64')}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-ExperimentalApi': 'opt-in'
            }
        };

        let response;
        try {
            response = await axios.post(
                `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
                payload,
                requestConfig
            );
        } catch (error) {
            const message = JSON.stringify(error.response?.data || {});
            const canRetryWithoutFields = error.response?.status === 400 && normalizedFields.length > 0 && /Invalid request payload/i.test(message);
            if (!canRetryWithoutFields) {
                throw error;
            }
            const fallbackPayload = {
                jql,
                maxResults
            };
            if (nextPageToken) {
                fallbackPayload.nextPageToken = nextPageToken;
            }
            response = await axios.post(
                `${JIRA_CONFIG.baseUrl}rest/api/3/search/jql`,
                fallbackPayload,
                requestConfig
            );
        }

        const data = response.data || {};
        const issues = Array.isArray(data.issues) ? data.issues : [];

        const trimmedIssues = issues.map(issue => {
            const trimmedFields = {};
            if (issue.fields && typeof issue.fields === 'object') {
                normalizedFields.forEach(fieldName => {
                    if (Object.prototype.hasOwnProperty.call(issue.fields, fieldName)) {
                        trimmedFields[fieldName] = issue.fields[fieldName];
                    }
                });
            }
            return {
                id: issue.id,
                key: issue.key,
                self: issue.self,
                fields: trimmedFields
            };
        });

        const trimmedResponse = {
            issues: trimmedIssues,
            startAt: Number.isFinite(data.startAt) ? data.startAt : startAt,
            maxResults: Number.isFinite(data.maxResults) ? data.maxResults : maxResults,
            total: Number.isFinite(data.total) ? data.total : trimmedIssues.length + startAt,
            nextPageToken: typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0 ? data.nextPageToken : null,
            isLast: typeof data.isLast === 'boolean' ? data.isLast : undefined,
            warningMessages: Array.isArray(data.warningMessages) && data.warningMessages.length ? data.warningMessages : undefined,
            names: data.names,
            schema: data.schema
        };

        setApiSearchCache(cacheKey, trimmedResponse);

        res.json(trimmedResponse);
    } catch (error) {
        const status = error.response?.status || 500;
        console.error('JIRA API Error:', error.response?.data || error.message);
        res.status(status).json({
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
# Feature Lifecycle Navigator (FLN)

A comprehensive Jira- Feature Strategy Engine(FSE) platform for tracking epics, stories, and bugs with advanced features including email notifications, JIRA integration, and real-time status tracking.

## 🚀 Features

- **Epic & Story Tracking**: View hierarchical relationships between epics, stories, and bugs
- **Email Notifications**: Automated email alerts for missing descriptions, acceptance criteria, and unassigned issues
- **JIRA Integration**: Direct links to JIRA issues and seamless navigation
- **Real-time Search**: Dynamic JQL-based searching with autocomplete
- **Responsive Design**: Modern, professional UI with interactive elements
- **Status Monitoring**: Real-time status tracking and progress indicators

## 📋 Prerequisites

- Node.js (v14 or higher)
- JIRA instance with API access
- Valid JIRA credentials

## 🛠️ Installation

1. Clone the repository:
```bash
git clone https://github.com/ZuhaMujawar/Jira_Assistance.git
cd Feature-Lifecycle-Navigator-FLN-
```

2. Install dependencies:
```bash
npm install
```

3. Configure JIRA credentials:
    - Update the proxy server configuration in `server/proxy-server.js`
    - Set your JIRA base URL in `public/dashboard.html`

## 🚀 Usage

1. Start the proxy server:
```bash
npm start
```
or use the batch file:
```bash
scripts/start-proxy.bat
```

2. Open your browser and navigate to:
```
http://localhost:3000/dashboard.html
```

3. Enter JQL queries to search for issues

## 📁 Project Structure

```
├── public/                        # Static web assets
│   ├── dashboard.html             # Main dashboard interface
│   ├── Demo.html                  # Login/demo page
│   ├── test-jira.html             # JIRA connectivity test page
│   ├── Presentation.html          # Presentation page
│   ├── capability-discovery.html
│   ├── capability-fetching-guide.html
│   ├── documentation-generator-guide.html
│   └── field-discovery.html
├── server/
│   ├── proxy-server.js            # Express proxy server for JIRA API
│   └── send-emails.js             # Email helper script
├── scripts/
│   └── start-proxy.bat            # Windows launcher
├── docs/                          # Project documentation
│   ├── ENV_SETUP.md
│   ├── JIRA_INTEGRATION_GUIDE.md
│   ├── PowerPoint_Creation_Guide.md
│   ├── PowerPoint_Script.md
│   └── Project_Presentation.md
├── package.json
└── package-lock.json
```

## ✨ Key Features

### Email Notifications
- **Assignee Notifications**: Automatic emails to assignees for missing descriptions and acceptance criteria
- **Reporter Notifications**: Alerts to reporters for unassigned issues
- **Professional Templates**: Well-formatted email templates with clear action items

### JIRA Integration
- **Clickable Issue Keys**: Direct navigation to JIRA issues
- **Real-time Status**: Live status updates and progress tracking
- **Hierarchical View**: Epic → Story → Bug relationships

### Search & Filter
- **JQL Autocomplete**: Smart autocomplete for fix versions
- **Dynamic Results**: Real-time search results with loading indicators
- **Advanced Filtering**: Support for complex JQL queries

## 🔧 Configuration

### JIRA Base URL
Update the JIRA base URL in `public/dashboard.html`:
```javascript
const jiraBaseUrl = 'https://your-instance.atlassian.net';
```

### Email Configuration
The system uses mailto links for email functionality. Emails are sent to:
- **Assignees**: For missing description/acceptance criteria
- **Reporters**: For unassigned issues

### Proxy Server
Configure JIRA credentials in `server/proxy-server.js`:
```javascript
// Update with your JIRA instance details
const jiraBaseUrl = 'https://your-instance.atlassian.net';
// Configure authentication as needed
```

## 📊 Dashboard Sections

1. **Statistics Summary**: Overview of features and epics
2. **Feature Cards**: Expandable cards showing epic details
3. **Story Lists**: Detailed story information with status
4. **Bug Tracking**: Bug lists with priority and status
5. **Orphaned Stories**: Stories not linked to epics

## 🎨 UI Features

- **Interactive Cards**: Expandable feature cards with smooth animations
- **Status Indicators**: Color-coded status badges
- **Responsive Layout**: Works on desktop and mobile devices
- **Professional Design**: Modern, clean interface with consistent styling

## 🔍 Search Capabilities

- **JQL Support**: Full JQL query support
- **Fix Version Autocomplete**: Smart suggestions for fix versions
- **Real-time Results**: Instant search results
- **Error Handling**: Comprehensive error messaging

## 📧 Email System

### For Assignees
- Missing Description alerts
- Missing Acceptance Criteria notifications
- Professional email templates with step-by-step instructions

### For Reporters
- Unassigned issue notifications
- Clear action items for assignment

## 🛡️ Security

- CORS-enabled proxy server
- Secure JIRA API integration
- Error handling and validation

## 🚀 Getting Started

1. Set up your JIRA instance and obtain API credentials
2. Configure the proxy server with your JIRA details
3. Start the proxy server
4. Open the dashboard and start searching!

## 📱 Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 📞 Support

For support and questions, please open an issue in the GitHub repository.

---

**Note**: This dashboard requires a valid JIRA instance and proper API credentials to function correctly.
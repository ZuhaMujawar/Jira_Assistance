# Environment Setup

## JIRA API Configuration

1. Create a `.env` file in the project root directory
2. Add your JIRA API token to the `.env` file:

```
JIRA_API_TOKEN=your_actual_api_token_here
```

## Getting a JIRA API Token

1. Go to your Atlassian Account Settings: https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Give it a descriptive label (e.g., "FLN Dashboard Token")
4. Copy the generated token
5. Add it to your `.env` file as shown above

## Important Notes

- Never commit the `.env` file to version control
- The `.env` file is already included in `.gitignore`
- Replace `your_actual_api_token_here` with your real JIRA API token
- Keep your API token secure and don't share it with others
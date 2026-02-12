const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Email sending script using Node.js with Outlook COM automation
async function sendEmailsViaOutlook(emailsData) {
    try {
        // Create temporary file for email data to avoid command line parsing issues
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `emails_${Date.now()}.json`);
        
        // Write email data to temporary file
        fs.writeFileSync(tempFile, JSON.stringify(emailsData, null, 2));
        
        // Create PowerShell script content for Outlook automation
        const powershellScript = `
Add-Type -AssemblyName Microsoft.Office.Interop.Outlook

try {
    # Create Outlook application
    $outlook = New-Object -ComObject Outlook.Application
    $namespace = $outlook.GetNamespace("MAPI")
    
    # Read emails data from temporary file
    $emailsJson = Get-Content -Path "${tempFile.replace(/\\/g, '/')}" -Raw
    $emails = $emailsJson | ConvertFrom-Json
    
    $successCount = 0
    $failureCount = 0
    
    foreach ($email in $emails) {
        try {
            Write-Host "📧 Sending email for story: $($email.story)"
            
            # Create mail item
            $mailItem = $outlook.CreateItem(0)  # olMailItem = 0
            
            # Set email properties
            $mailItem.To = $email.reporterEmail
            if ($email.assigneeEmail -and ($email.assigneeEmail -ne $email.reporterEmail)) {
                $mailItem.CC = $email.assigneeEmail
            }
            $mailItem.Subject = "Missing required field - $($email.story) - Action Required"
            $mailItem.Body = $email.body
            
            # Send email
            $mailItem.Send()
            
            Write-Host "✅ Email sent successfully for $($email.story)"
            $successCount++
            
            # Small delay between emails
            Start-Sleep -Milliseconds 1000
        }
        catch {
            Write-Host "❌ Failed to send email for $($email.story): $($_.Exception.Message)"
            $failureCount++
        }
    }
    
    # Clean up temporary file
    if (Test-Path "${tempFile.replace(/\\/g, '/')}") {
        Remove-Item -Path "${tempFile.replace(/\\/g, '/')}" -Force
    }
    
    # Output results
    Write-Host "📊 Email sending completed:"
    Write-Host "   ✅ Successful: $successCount"
    Write-Host "   ❌ Failed: $failureCount"
    
    # Return JSON result
    $result = @{
        success = $successCount
        failure = $failureCount
        total = $emails.Count
    }
    
    $result | ConvertTo-Json
}
catch {
    # Clean up temporary file on error
    if (Test-Path "${tempFile.replace(/\\/g, '/')}") {
        Remove-Item -Path "${tempFile.replace(/\\/g, '/')}" -Force
    }
    
    Write-Host "❌ Error accessing Outlook: $($_.Exception.Message)"
    $errorResult = @{
        success = 0
        failure = 0
        total = 0
        error = $_.Exception.Message
    }
    $errorResult | ConvertTo-Json
}
`;

        return new Promise((resolve, reject) => {
            // Execute PowerShell script without command line arguments
            const ps = spawn('powershell.exe', ['-Command', powershellScript], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            let output = '';
            let errorOutput = '';
            
            ps.stdout.on('data', (data) => {
                output += data.toString();
                console.log('PowerShell Output:', data.toString());
            });
            
            ps.stderr.on('data', (data) => {
                errorOutput += data.toString();
                console.error('PowerShell Error:', data.toString());
            });
            
            ps.on('close', (code) => {
                // Cleanup temporary file
                try {
                    if (fs.existsSync(tempFile)) {
                        fs.unlinkSync(tempFile);
                    }
                } catch (cleanupError) {
                    console.warn('Warning: Could not cleanup temporary file:', cleanupError.message);
                }
                
                if (code === 0) {
                    try {
                        // Extract JSON result from output - handle multiline JSON
                        console.log('Full PowerShell output for parsing:', output);
                        const cleanOutput = output.replace(/\r/g, ''); // Remove carriage returns
                        const lines = cleanOutput.split('\n');
                        
                        // Find the JSON block - look for multiline JSON object
                        let jsonStartIndex = -1;
                        let jsonEndIndex = -1;
                        
                        // Find the start and end of JSON block
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line === '{' && jsonStartIndex === -1) {
                                jsonStartIndex = i;
                            }
                            if (line === '}' && jsonStartIndex !== -1) {
                                jsonEndIndex = i;
                                break;
                            }
                        }
                        
                        if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
                            // Reconstruct the JSON from the lines
                            const jsonLines = lines.slice(jsonStartIndex, jsonEndIndex + 1);
                            const jsonString = jsonLines.join('\n');
                            console.log('Found JSON block:', jsonString);
                            
                            const result = JSON.parse(jsonString);
                            console.log('Parsed result:', result);
                            resolve(result);
                        } else {
                            console.log('No JSON block found in output lines:', lines);
                            resolve({
                                success: 0,
                                failure: emailsData.length,
                                total: emailsData.length,
                                error: 'No valid result returned from PowerShell'
                            });
                        }
                    } catch (parseError) {
                        console.log('JSON parse error:', parseError.message);
                        console.log('Output that failed to parse:', output);
                        resolve({
                            success: 0,
                            failure: emailsData.length,
                            total: emailsData.length,
                            error: 'Failed to parse PowerShell result'
                        });
                    }
                } else {
                    reject(new Error(`PowerShell script failed with code ${code}: ${errorOutput}`));
                }
            });
        });
        
    } catch (error) {
        console.error('Error in sendEmailsViaOutlook:', error);
        
        // Cleanup temporary file in case of error
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch (cleanupError) {
            console.warn('Warning: Could not cleanup temporary file:', cleanupError.message);
        }
        
        return {
            success: 0,
            failure: emailsData.length,
            total: emailsData.length,
            error: error.message
        };
    }
}

module.exports = { sendEmailsViaOutlook };
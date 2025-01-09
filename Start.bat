@echo off
REM Navigate to the bot's directory
cd /d "G:\Coding\The-Great-Clock"

REM Check if .env exists (optional step to confirm environment setup)
if not exist .env (
    echo Missing .env file. Ensure the .env file is present before running the bot.
    pause
    exit /b
)

REM Display Node.js version
node -v

REM Start the bot
echo Starting the bot...
node index.js

REM Wait for any errors to be displayed before closing
echo Bot has stopped. Press any key to exit...
pause

# The Great Clock Bot

The **Great Clock Bot** is a Discord bot designed for XP leveling, role management, and creating and sending custom embed messages across multiple servers. Its features include tracking user activity, assigning roles based on levels, importing user data, creating and managing embeds, and logging bot activity.

---

## Features

- XP leveling system with customizable base XP and multiplier.
- Automatic role assignment based on levels.
- Import user data.
- Create and send custom embed messages.
- Adjustable XP cooldown for user activity.

---

## Commands

### XP and Leveling
1. **`/profile [user]`**
   - Displays the profile of the specified user or the command executor, including:
     - Current level.
     - Total XP.
     - Progress bar toward the next level.
     - Estimated messages required to level up.

2. **`/setxp <user> [xp] [level]`**
   - Manually sets a user's XP or level.
   - If both XP and level are provided, XP is calculated based on the level.

3. **`/setbasexp <value>`**
   - Sets the base XP required for leveling up globally.

4. **`/setmultiplier <value>`**
   - Sets the multiplier used to calculate XP requirements for each level globally.

5. **`/setlevelrole <level> <role>`**
   - Assigns a role to users when they reach a specified level.

6. **`/importuserdata`**
   - Imports user levels from a JSON file. Only imports levels to avoid overwriting XP. (old polaris/solana bot data)

---

### Embed Management
7. **`/sendembed`**
   - Sends the previously created embed to multiple servers and channels. You can:
     - Select multiple servers.
     - Select multiple channels within each server.

---

## Installation

### Prerequisites
- Node.js v16 or higher.
- A Discord bot token.
- SQLite installed or included as part of your Node.js setup.

### Steps
1. Clone the repository:
   ```bash
   git clone https://github.com/your-repo/TheGreatClock.git
   cd TheGreatClock
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file:
   ```plaintext
   TOKEN=your-bot-token
   CLIENT_ID=your-client-id
   ```
   Replace `your-bot-token` and `your-client-id` with your bot's token and client ID.

4. Run the bot:
   ```bash
   node index.js
   ```

---

## Customization

### XP Leveling
- Adjust the default `base_xp` and `multiplier` in the `guild_settings` table to fine-tune the XP leveling curve.

### Embed Management
- Modify `/sendembed` command to fit your server's unique needs.

---

## Contributing
Feel free to submit issues or pull requests. Contributions are welcome!

---

## License
This project is licensed under the MIT License.

---

For questions or support, feel free to contact me via GitHub Issues or Discord!

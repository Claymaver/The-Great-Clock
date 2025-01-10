Here’s the updated **README** with the new commands added:

---

# The Great Clock Bot

The **Great Clock Bot** is a Discord bot designed for XP leveling, role management, creating and sending custom embed messages across multiple servers, and global moderation tools (ban/kick). Its features include tracking user activity, assigning roles based on levels, importing user data, creating embeds, and global ban management.

---

## Features

- XP leveling system with customizable base XP and multiplier.
- Automatic role assignment based on levels.
- Import user data.
- Create and send custom embed messages.
- Global ban/kick management across multiple servers.
- Adjustable XP cooldown for user activity.

---

## Commands

### XP and Leveling

1. **`/tgc-profile [user]`**
   - Displays the profile of the specified user or the command executor, including:
     - Current level.
     - Total XP.
     - Progress bar toward the next level.
     - Estimated messages required to level up.

2. **`/tgc-setxp <user> [xp] [level]`**
   - Manually sets a user's XP or level.
   - If both XP and level are provided, XP is calculated based on the level.

3. **`/tgc-setbasexp <value>`**
   - Sets the base XP required for leveling up globally.

4. **`/tgc-setmultiplier <value>`**
   - Sets the multiplier used to calculate XP requirements for each level globally.

5. **`/tgc-setlevelrole <level> <role>`**
   - Assigns a role to users when they reach a specified level.

6. **`/tgc-importuserdata`**
   - Imports user levels from a JSON file. Only imports levels to avoid overwriting XP. (Supports old Polaris/Solana bot data)

---

### Embed Management

7. **`/tgc-createembed`**
   - Creates an embed to send. Features include:
     - Selecting multiple servers.
     - Selecting embed color.
     - Selecting multiple channels within each server.
     - **(Future)** Ability to attach files.

---

### Moderation

8. **`/tgc-ban <user> [duration] [reason]`**
   - Globally bans a user across all servers the bot is in.
   - **`duration`**: hours. Leave blank for a permanent ban.
   - Logs the ban reason and expiration in the database.

9. **`/tgc-kick <user> [reason]`**
   - Kicks a user from all servers the bot is in.
   - Logs the reason for the kick.

10. **`/tgc-banlist`**
    - Displays the global ban list, including:
      - Usernames.
      - User IDs.
      - Reasons.
      - Ban expiration (relative time for temporary bans).

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

### Moderation
- Modify the `global_bans` table structure in `better-sqlite3` to add fields as necessary for expanded functionality.

---

## Contributing
Feel free to submit issues or pull requests. Contributions are welcome!

---

## License
This project is licensed under the MIT License.

---

For questions or support, feel free to contact me via GitHub Issues or Discord! 

---
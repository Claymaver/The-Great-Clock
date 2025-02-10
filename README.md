Sure! Here's the updated **README** with the predefined embed colors **explicitly listed** under the **Customization** section.

---

# **The Great Clock**  

The **Great Clock Bot** is a Discord bot designed for XP leveling, role management, creating and sending custom embed messages across multiple servers, global moderation tools (ban/kick), and **automated message forwarding and publishing**.  

---

## **Features**  

- XP leveling system with customizable base XP and multiplier.  
- Automatic role assignment based on levels.  
- Import user data.  
- Create and send custom embed messages.  
- Global ban/kick management across multiple servers.  
- Adjustable XP cooldown for user activity.  
- **Auto-publishing for announcement channels** (toggle per channel).  
- **Forward messages from one channel to another (cross-server supported).**  

---

## **Commands**  

### **XP and Leveling**  

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

### **Embed & Message Management**  

7. **`/tgc-createembed`**  
   - Creates an embed to send. Features include:  
     - Selecting multiple servers.  
     - Selecting embed color.  
     - Selecting multiple channels within each server.  
     - Attach image link to include in the embed.  

---

### **Message Forwarding**  

8. **`/forward <source_id> <target_id> [color]`**  
   - Forwards messages from one channel to another (including across different servers).  
   - **`source_id`**: The channel ID where messages will be forwarded from.  
   - **`target_id`**: The channel ID where messages will be sent to.  
   - **`color`** _(optional)_: Select an embed color from predefined choices.  

9. **`/removeforward <source_id>`**  
   - Removes message forwarding for a specific source channel.  

### **Message Forwarding & Embed Colors**  
- Customize available **embed colors** by modifying the predefined `EMBED_COLORS` list in the code.  

#### **📌 Current Predefined Colors:**  
| Name           | Hex Code  |  
|---------------|----------|  
| **Pink**       | `#eb0062` |  
| **Red**        | `#ff0000` |  
| **Dark Red**   | `#7c1e1e` |  
| **Orange**     | `#ff4800` |  
| **Yellow**     | `#ffe500` |  
| **Green**      | `#1aff00` |  
| **Forest Green** | `#147839` |  
| **Light Blue** | `#00bdff` |  
| **Dark Blue**  | `#356feb` |  

- Use these color names when selecting a color in the **`/forward`** command.  
- Example:  
  ```bash
  /forward source_id:123456789012345678 target_id:987654321098765432 color:"Dark Blue"
  ```

---

### **Auto-Publishing (For Announcement Channels)**  

10. **`/toggleautopublish <channel>`**  
    - Enables or disables **auto-publishing** for a specific **announcement (news) channel**.  
    - If enabled, messages posted in the specified channel will be **automatically published**.  
    - If disabled, the bot will **not** publish messages in that channel.  

---

### **Moderation**  

11. **`/tgc-ban <user> [duration] [reason]`**  
    - Globally bans a user across all servers the bot is in.  
    - **`duration`**: hours. Leave blank for a permanent ban.  
    - Logs the ban reason and expiration in the database.  

12. **`/tgc-kick <user> [reason]`**  
    - Kicks a user from all servers the bot is in.  
    - Logs the reason for the kick.  

13. **`/tgc-banlist`**  
    - Displays the global ban list, including:  
      - Usernames.  
      - User IDs.  
      - Reasons.  
      - Ban expiration (relative time for temporary bans).  
14. **`/tgc-openticket`**
   - allows users to report issues or ask staff for assistance

15. **`/tgc-closeticket`**
   - closes current ticket

16 **`/tgc-setlogchanne`**
   - sets logging channel for tickets

---

### **Role-Based Command Permissions**  

- Most commands are now restricted based on roles configured via the `/tgc-managecommandroles` command.  
- The **`/tgc-profile`** and **`/tgc-openticket`** are **public** and can be used by anyone.  
- Other commands require the user to have a role specified in the `command_roles` table.  

---

### **How to Use**  

- To enable role-based command permissions:  
  1. Use `/tgc-managecommandroles action:add role:@RoleName` to add a role that can use restricted commands.  
  2. Repeat for each required role.  

- To remove a role from having permissions:  
  - Use `/tgc-managecommandroles action:remove role:@RoleName`.  

---

## **Installation**  

### **Prerequisites**  
- Node.js v16 or higher.  
- A Discord bot token.  
- SQLite installed or included as part of your Node.js setup.  

### **Steps**  

1. **Clone the repository:**  
   ```bash
   git clone https://github.com/your-repo/TheGreatClock.git
   cd TheGreatClock
   ```

2. **Install dependencies:**  
   ```bash
   npm install
   ```

3. **Create a `.env` file:**  
   ```plaintext
   TOKEN=your-bot-token
   CLIENT_ID=your-client-id
   ```
   Replace `your-bot-token` and `your-client-id` with your bot's token and client ID.  

4. **Run the bot:**  
   ```bash
   node index.js
   ```

---

## **Customization**  

### **XP Leveling**  
- Adjust the default `base_xp` and `multiplier` in the `guild_settings` table to fine-tune the XP leveling curve.  

### **Moderation**  
- Modify the `global_bans` table structure in `better-sqlite3` to add fields as necessary for expanded functionality.  

---

## **Contributing**  
Feel free to submit issues or pull requests. Contributions are welcome!  

---

## **License**  
This project is licensed under the MIT License.  

---

For questions or support, feel free to contact me via GitHub Issues or Discord! 

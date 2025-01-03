# Rivet - A Discord Leveling and Role Management Bot

Rivet is a customizable Discord bot designed to manage user leveling systems, assign roles dynamically, and enhance server engagement with intuitive and interactive features.

---

## Features

- **Dynamic Leveling System**:
  - Tracks user activity and awards XP based on message count.
  - Configurable leveling formula (`Linear`, `Exponential`, or custom). (custom doesn't work right now, please do not use it)

- **Role Management**:
  - Automatically assigns roles based on user levels.
  - Supports custom roles and commands for advanced server management.

- **Interactive UI**:
  - Dropdown menus and buttons for setting configurations.
  - Beautiful embeds for displaying server-specific settings.

- **Cross-Server Sync**:
  - Syncs XP and level data across multiple servers.

---

## Installation

### Prerequisites

- Python 3.8 or higher
- SQLite3 (comes pre-installed with Python)
- A Discord bot token (from the [Discord Developer Portal](https://discord.com/developers/applications))

### Setup Instructions

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/Claymaver/Rivet.git
   cd Rivet
   ```

2. **Install Dependencies**:
   Use `pip` to install required Python libraries:
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure Your Bot Token**:
   - open the python main.py file and scroll to the bottom and input your bot token

4. **Initialize the Database**:
   Run the bot once to ensure the database schema is created:
   ```bash
   python main.py
   ```

---

## Commands

### **Leveling Commands**
- `/view_leveling_settings` - View the current leveling configuration for your server.
- `/set_leveling_formula` - Set the leveling formula (`Linear`, `Exponential`, or `Custom`).

### **Role Management Commands**
- `/assign_command_role` - Assign roles to commands using an interactive UI.
- `/remove_command_role` - Remove a role assigned to a command.
- `/view_assigned_roles` - View roles currently assigned to commands.

### **XP Management**
- `/force_sync` - Manually sync user XP across selected servers.
- `/edit_user_level` - Modify a user's level or XP manually.

---

## Usage

### Running the Bot
Start the bot with:
```bash
python main.py
```
there is also a bat file included to lauch it with instead

### Inviting the Bot to Your Server
Use the OAuth2 URL generated from the Discord Developer Portal to invite your bot:
1. Go to the "OAuth2" tab.
2. Select "bot" and "applications.commands" scopes.
3. Copy the generated URL and open it in your browser.

---

## Contributing

Contributions are welcome! If you have ideas for new features or find a bug, feel free to open an issue or submit a pull request.

---

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.

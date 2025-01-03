import discord
from discord.ext import commands, tasks
from discord import app_commands, SelectOption
import sqlite3
import random
import time
import asyncio

# Set up bot
intents = discord.Intents.default()
intents.messages = True
intents.guilds = True
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

# Connect to SQLite database
conn = sqlite3.connect('leveling.db')

c = conn.cursor()

# Command ROles Table Creation
c.execute('''
CREATE TABLE IF NOT EXISTS user_xp (
    user_id INTEGER,
    guild_id INTEGER,
    xp INTEGER,
    PRIMARY KEY (user_id, guild_id)
)
''')

conn.commit()

# Create tables

c.execute('''
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id INTEGER PRIMARY KEY,
    embed_color INTEGER DEFAULT 3447003  -- Default Discord blue color
)
''')
c.execute('''
CREATE TABLE IF NOT EXISTS user_xp (
    user_id INTEGER,
    guild_id INTEGER,
    xp REAL DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
)
''')
c.execute('''
CREATE TABLE IF NOT EXISTS leveling_settings (
    guild_id INTEGER PRIMARY KEY,
    base_xp INTEGER DEFAULT 100,
    formula TEXT DEFAULT 'square_root',
    cooldown INTEGER DEFAULT 60
)
''')
c.execute('''
CREATE TABLE IF NOT EXISTS user_activity (
    user_id INTEGER,
    guild_id INTEGER,
    last_xp_time INTEGER,
    PRIMARY KEY (user_id, guild_id)
)
''')
c.execute('''
CREATE TABLE IF NOT EXISTS level_roles (
    guild_id INTEGER,
    level INTEGER,
    role_id INTEGER,
    PRIMARY KEY (guild_id, level)
)
''')
c.execute('''
CREATE TABLE IF NOT EXISTS command_roles (
    guild_id INTEGER,
    command_name TEXT,
    role_id INTEGER,
    PRIMARY KEY (guild_id, command_name)
)
''')

conn.commit()

def ensure_guild_settings_schema():
    # Get the current schema of the guild_settings table
    c.execute("PRAGMA table_info(guild_settings);")
    columns = [row[1] for row in c.fetchall()]

    # Add missing columns dynamically
    if 'base_xp' not in columns:
        c.execute("ALTER TABLE guild_settings ADD COLUMN base_xp INTEGER DEFAULT 300")
    if 'cooldown' not in columns:
        c.execute("ALTER TABLE guild_settings ADD COLUMN cooldown INTEGER DEFAULT 60")
    if 'leveling_formula' not in columns:
        c.execute("ALTER TABLE guild_settings ADD COLUMN leveling_formula TEXT DEFAULT 'linear'")

    # Ensure the table exists (no-op if already present)
    c.execute("""
        CREATE TABLE IF NOT EXISTS guild_settings (
            guild_id INTEGER PRIMARY KEY
        )
    """)
    conn.commit()

# Call this function during bot startup
ensure_guild_settings_schema()



# Functions for managing XP and levels
def calculate_level(xp, guild_id):
    c.execute("SELECT base_xp, formula FROM leveling_settings WHERE guild_id = ?", (guild_id,))
    result = c.fetchone()
    base_xp, formula = result if result else (100, 'square_root')

    if formula == 'square_root':
        return int((xp / base_xp) ** 0.5)
    elif formula == 'linear':
        return int(xp / base_xp)
    elif formula == 'custom':
        return int((xp / base_xp) ** 0.8)
    elif formula == 'exponential':
        return int((xp / base_xp) ** 0.3)  # Exponential formula (adjust power as needed)
    return 0  # Default if no formula matches


def can_earn_xp(user_id, guild_id):
    current_time = int(time.time())
    c.execute('''
    SELECT ua.last_xp_time, ls.cooldown
    FROM user_activity ua
    LEFT JOIN leveling_settings ls
    ON ua.guild_id = ls.guild_id
    WHERE ua.user_id = ? AND ua.guild_id = ?
    ''', (user_id, guild_id))
    result = c.fetchone()
    if result:
        last_xp_time, cooldown = result
        if last_xp_time and cooldown:
            return current_time - last_xp_time >= cooldown
    return True

def update_last_xp_time(user_id, guild_id):
    current_time = int(time.time())
    c.execute('''
    INSERT INTO user_activity (user_id, guild_id, last_xp_time)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id, guild_id) DO UPDATE SET last_xp_time = ?
    ''', (user_id, guild_id, current_time, current_time))
    conn.commit()

def update_user_xp(user_id, guild_id, xp_gain):
    c.execute('''
    INSERT INTO user_xp (user_id, guild_id, xp)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id, guild_id) DO UPDATE SET xp = xp + ?
    ''', (user_id, guild_id, xp_gain, xp_gain))
    conn.commit()
    c.execute('SELECT xp FROM user_xp WHERE user_id = ? AND guild_id = ?', (user_id, guild_id))
    return c.fetchone()[0]

async def assign_roles(member, level, guild):
    """
    Assign the role for the user's current level and remove roles for all other levels.
    """
    guild_id = guild.id

    # Fetch all level-role mappings for the guild
    c.execute("SELECT level, role_id FROM level_roles WHERE guild_id = ? ORDER BY level ASC", (guild_id,))
    level_roles = c.fetchall()

    if not level_roles:
        return  # No roles configured for this guild

    current_role = None
    roles_to_remove = []

    # Determine the role to assign and collect all roles to remove
    for lvl, role_id in level_roles:
        role = guild.get_role(role_id)
        if not role:
            continue  # Skip if the role no longer exists in the guild

        if level >= lvl:
            current_role = role  # This is the highest role the user qualifies for
        else:
            roles_to_remove.append(role)  # Add all higher level roles to be removed if the level is not enough

    # Remove roles that are no longer relevant for the current level
    for role in member.roles:
        if role in roles_to_remove:
            await member.remove_roles(role)

    # Assign the current level role if not already assigned
    if current_role and current_role not in member.roles:
        await member.add_roles(current_role)
        print(f"Assigned role '{current_role.name}' to {member.display_name} for level {level}.")


# Events
@bot.event
async def on_ready():
    print(f"Bot connected as {bot.user}")
    try:
        synced = await bot.tree.sync()
        print(f"Slash commands synced: {len(synced)} commands.")

        # Start the XP sync task
        if not sync_xp_across_selected_guilds.is_running():
            sync_xp_across_selected_guilds.start()

    except Exception as e:
        print(f"Failed to sync commands or start tasks: {e}")


@bot.event
async def on_message(message):
    if message.author.bot:
        return
    guild_id = message.guild.id
    user_id = message.author.id
    if not can_earn_xp(user_id, guild_id):
        return
    xp_gain = random.uniform(1.0, 5.0)
    total_xp = update_user_xp(user_id, guild_id, xp_gain)
    update_last_xp_time(user_id, guild_id)
    new_level = calculate_level(total_xp, guild_id)
    await assign_roles(message.author, new_level, message.guild)

# Slash commands
@bot.tree.command(name="set_base_xp", description="Set the base XP required for level 1.")
@app_commands.describe(base_xp="The XP required for level 1 (must be greater than 0).")
async def set_base_xp(interaction: discord.Interaction, base_xp: int):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return
    if base_xp <= 0:
        await interaction.response.send_message("Base XP must be greater than 0.", ephemeral=True)
        return
    guild_id = interaction.guild.id
    c.execute('''
    INSERT INTO leveling_settings (guild_id, base_xp)
    VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET base_xp = ?
    ''', (guild_id, base_xp, base_xp))
    conn.commit()
    await interaction.response.send_message(f"Base XP for level 1 has been set to {base_xp}.")

from discord import SelectOption, Embed, ButtonStyle
from discord.ui import View, Select, Button

class SetLevelingFormulaView(View):
    def __init__(self):
        super().__init__()
        self.selected_formula = None

        # Dropdown for leveling formulas
        self.formula_select = Select(
            placeholder="Select a leveling formula...",
            options=[
                SelectOption(label="Linear", value="linear", description="XP increases linearly per level."),
                SelectOption(label="Exponential", value="exponential", description="XP increases exponentially."),
                SelectOption(label="Custom", value="custom", description="Define a custom leveling formula."),
            ]
        )
        self.formula_select.callback = self.select_formula
        self.add_item(self.formula_select)

        # Submit button
        self.submit_button = Button(label="Submit", style=ButtonStyle.green)
        self.submit_button.callback = self.submit
        self.add_item(self.submit_button)

        # Cancel button
        self.cancel_button = Button(label="Cancel", style=ButtonStyle.red)
        self.cancel_button.callback = self.cancel
        self.add_item(self.cancel_button)

    async def select_formula(self, interaction: discord.Interaction):
        self.selected_formula = self.formula_select.values[0]
        await interaction.response.defer()

    async def submit(self, interaction: discord.Interaction):
        if not self.selected_formula:
            await interaction.response.send_message(
                "Please select a leveling formula before submitting.", ephemeral=True
            )
            return

        # Save the selected formula to the database
        guild_id = interaction.guild.id
        c.execute("""
            INSERT INTO guild_settings (guild_id, leveling_formula)
            VALUES (?, ?)
            ON CONFLICT (guild_id) DO UPDATE SET leveling_formula = ?
        """, (guild_id, self.selected_formula, self.selected_formula))
        conn.commit()

        # Confirmation embed
        embed = Embed(
            title="Leveling Formula Set",
            description=f"The leveling formula has been set to `{self.selected_formula.capitalize()}`.",
            color=0x00FF00,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    async def cancel(self, interaction: discord.Interaction):
        await interaction.response.send_message(
            "Leveling formula selection has been canceled.", ephemeral=True
        )
        self.stop()


@bot.tree.command(
    name="set_leveling_formula",
    description="Set the leveling formula for this server."
)
async def set_leveling_formula(interaction: discord.Interaction):
    """
    Display a dropdown menu to set the leveling formula.
    """
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "You need to be an administrator to use this command.", ephemeral=True
        )
        return

    # Send the view
    view = SetLevelingFormulaView()
    embed = Embed(
        title="Set Leveling Formula",
        description="Select a leveling formula from the dropdown menu below.",
        color=0x3498DB,
    )
    await interaction.response.send_message(embed=embed, view=view)


@bot.tree.command(name="set_xp_cooldown", description="Set the cooldown before users can earn XP again.")
@app_commands.describe(cooldown="Cooldown in seconds (must be positive).")
async def set_xp_cooldown(interaction: discord.Interaction, cooldown: int):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return
    if cooldown <= 0:
        await interaction.response.send_message("Cooldown must be a positive number.", ephemeral=True)
        return
    guild_id = interaction.guild.id
    c.execute('''
    INSERT INTO leveling_settings (guild_id, cooldown)
    VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET cooldown = ?
    ''', (guild_id, cooldown, cooldown))
    conn.commit()
    await interaction.response.send_message(f"The XP cooldown has been set to {cooldown} seconds.")

@bot.tree.command(
    name="view_leveling_settings",
    description="View the current leveling settings for this server."
)
async def view_leveling_settings(interaction: discord.Interaction):
    """
    Display the leveling settings for the server in a visually appealing embed.
    """
    guild_id = interaction.guild.id

    # Fetch settings from the database
    c.execute("SELECT embed_color, leveling_formula, base_xp, cooldown FROM guild_settings WHERE guild_id = ?", (guild_id,))
    result = c.fetchone()

    # Default values if settings are not set
    if not result:
        embed_color = 0x3498DB  # Default blue
        leveling_formula = "linear"
        base_xp = 300
        cooldown = 60
    else:
        embed_color, leveling_formula, base_xp, cooldown = result
        embed_color = embed_color or 0x3498DB  # Default blue if no color is set
        leveling_formula = leveling_formula or "linear"
        base_xp = base_xp or 300
        cooldown = cooldown or 60

    # Design the embed
    embed = discord.Embed(
        title="Leveling Settings",
        description="Here are the current leveling settings for this server:",
        color=embed_color,
    )
    embed.add_field(name="📊 Base XP", value=f"`{base_xp}` XP required to reach level 1", inline=False)
    embed.add_field(name="📈 Formula", value=f"`{leveling_formula.capitalize()}` formula for XP progression", inline=False)
    embed.add_field(name="⏱️ Cooldown", value=f"`{cooldown} seconds` cooldown between earning XP", inline=False)

    # Add some flair to the footer or thumbnail
    embed.set_thumbnail(url=interaction.guild.icon.url if interaction.guild.icon else None)
    embed.set_footer(text="Manage these settings with /set_leveling_formula, /set_xp_cooldown cooldown and /set_base_xp base_xp")

    # Send the embed
    await interaction.response.send_message(embed=embed, ephemeral=True)


@bot.tree.command(name="remove_level_role", description="Remove a role from a specific level.")
@app_commands.describe(level="The level to remove the role from.")
async def remove_level_role(interaction: discord.Interaction, level: int):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return
    guild_id = interaction.guild.id
    c.execute('DELETE FROM level_roles WHERE guild_id = ? AND level = ?', (guild_id, level))
    conn.commit()
    await interaction.response.send_message(f"Role for level {level} has been removed.")

@bot.tree.command(name="view_level_roles", description="View all level roles for this server.")
async def view_level_roles(interaction: discord.Interaction):
    guild_id = interaction.guild.id
    c.execute('SELECT level, role_id FROM level_roles WHERE guild_id = ?', (guild_id,))
    roles = c.fetchall()

    if roles:
        embed = discord.Embed(
            title="Level Roles",
            description="Roles assigned to levels in this server:",
            color=discord.Color.blue()
        )
        for level, role_id in roles:
            role = interaction.guild.get_role(role_id)
            if role:
                embed.add_field(name=f"Level {level}", value=f"{role.mention}", inline=False)
            else:
                embed.add_field(name=f"Level {level}", value="Unknown Role (Role was likely deleted)", inline=False)

        await interaction.response.send_message(embed=embed)
    else:
        embed = discord.Embed(
            title="No Level Roles Set",
            description="No roles have been assigned to levels in this server.",
            color=discord.Color.red()
        )
        await interaction.response.send_message(embed=embed)

@bot.tree.command(
    name="copy_guild_data",
    description="Copy all level role mappings and user data from another server to this server."
)
@app_commands.describe(source_guild_id="The ID of the server to copy data from.")
async def copy_guild_data(interaction: discord.Interaction, source_guild_id: str):
    try:
        # Acknowledge the interaction immediately to prevent timeout
        await interaction.response.defer(ephemeral=True)

        source_guild_id = int(source_guild_id)
        target_guild_id = interaction.guild.id

        source_guild = bot.get_guild(source_guild_id)
        if not source_guild:
            await interaction.followup.send(
                f"Could not find the source server with ID {source_guild_id}. Make sure the bot is in the server.",
                ephemeral=True,
            )
            return

        # Fetch level-role mappings from the source guild
        c.execute("SELECT level, role_id FROM level_roles WHERE guild_id = ?", (source_guild_id,))
        source_roles = c.fetchall()

        if not source_roles:
            await interaction.followup.send(
                f"No level roles found for the source server with ID {source_guild_id}.",
                ephemeral=True,
            )
            return

        # Check if the target guild already has level roles
        c.execute("SELECT level FROM level_roles WHERE guild_id = ?", (target_guild_id,))
        target_roles = c.fetchall()

        if target_roles:
            await interaction.followup.send(
                "This server already has level roles set. Clear them first before copying.",
                ephemeral=True,
            )
            return

        # Copy roles to the target guild
        for level, source_role_id in source_roles:
            source_role = source_guild.get_role(source_role_id)
            if not source_role:
                continue  # Skip if the role no longer exists in the source guild

            # Create a new role in the target server with the same properties as the source role
            target_role = await interaction.guild.create_role(
                name=source_role.name,
                permissions=source_role.permissions,
                color=source_role.color,
                hoist=source_role.hoist,
                mentionable=source_role.mentionable,
            )
            print(f"Created role '{target_role.name}' for level {level} in the target server.")

            # Save the copied role to the database
            c.execute(
                "INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?)",
                (target_guild_id, level, target_role.id),
            )

        # Copy user data (XP and cooldowns) to the target guild
        c.execute("SELECT user_id, xp FROM user_xp WHERE guild_id = ?", (source_guild_id,))
        user_xp_data = c.fetchall()

        for user_id, xp in user_xp_data:
            c.execute(
                "INSERT INTO user_xp (user_id, guild_id, xp) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET xp = ?",
                (user_id, target_guild_id, xp, xp),
            )

        c.execute("SELECT user_id, last_xp_time FROM user_activity WHERE guild_id = ?", (source_guild_id,))
        user_cooldown_data = c.fetchall()

        for user_id, last_xp_time in user_cooldown_data:
            c.execute(
                "INSERT INTO user_activity (user_id, guild_id, last_xp_time) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET last_xp_time = ?",
                (user_id, target_guild_id, last_xp_time, last_xp_time),
            )

        # Commit all changes to the database
        conn.commit()

        # Send final confirmation message
        await interaction.followup.send(
            f"Successfully copied all data (level roles and user data) from server ID {source_guild_id} to this server.",
            ephemeral=False,
        )
    except ValueError:
        await interaction.followup.send(
            "Invalid source guild ID. Please provide a valid server ID.",
            ephemeral=True,
        )
    except Exception as e:
        print(f"Error copying guild data: {e}")
        await interaction.followup.send(
            "An error occurred while copying data. Please try again later.",
            ephemeral=True,
        )



import json

@bot.tree.command(
    name="import_user_data",
    description="Import user data from a JSON file into the bot's database and create missing roles."
)
@app_commands.describe(file="The JSON file to import user data from.")
async def import_user_data(interaction: discord.Interaction, file: discord.Attachment):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return

    try:
        # Defer response since importing might take time
        await interaction.response.defer(ephemeral=True)

        # Download and parse the JSON file
        data = json.loads(await file.read())

        # Import rewards (level-role mappings)
        guild_id = interaction.guild.id
        rewards = data.get("settings", {}).get("rewards", [])
        for reward in rewards:
            level = reward["level"]
            role_id = int(reward["id"])

            # Check if the role exists in the guild
            role = interaction.guild.get_role(role_id)
            if not role:
                # Role not found, create it in the guild
                role_name = reward.get("name", f"Level {level} Role")
                role_color = discord.Color.default()
                if "color" in reward:  # If a color is provided in the JSON
                    role_color = discord.Color(int(reward["color"], 16))  # Convert hex color to Discord Color

                role = await interaction.guild.create_role(
                    name=role_name,
                    color=role_color,
                    mentionable=True
                )
                print(f"Created role '{role_name}' for level {level}.")

            # Save the role to the database
            c.execute(
                "INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?) ON CONFLICT (guild_id, level) DO UPDATE SET role_id = ?",
                (guild_id, level, role.id, role.id),
            )

        # Import user XP and cooldowns
        users = data.get("users", {})
        for user_id, user_data in users.items():
            xp = user_data.get("xp", 0)
            cooldown = user_data.get("cooldown", None)

            # Insert or update user data in the database
            c.execute(
                "INSERT INTO user_xp (user_id, guild_id, xp) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET xp = ?",
                (int(user_id), guild_id, xp, xp),
            )

            if cooldown:
                c.execute(
                    "INSERT INTO user_activity (user_id, guild_id, last_xp_time) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET last_xp_time = ?",
                    (int(user_id), guild_id, int(cooldown), int(cooldown)),
                )

        # Commit the changes to the database
        conn.commit()
        await interaction.followup.send("User data and level roles imported successfully!", ephemeral=False)

    except Exception as e:
        print(f"Error importing user data: {e}")
        await interaction.followup.send(
            "An error occurred while importing user data. Please check the file and try again.",
            ephemeral=True,
        )

@bot.tree.command(
    name="edit_user_level",
    description="Edit a user's level or XP."
)
@app_commands.describe(
    user="The user whose level or XP you want to edit.",
    level="The new level for the user (optional).",
    xp="The new XP value for the user (optional)."
)
async def edit_user_level(interaction: discord.Interaction, user: discord.Member, level: int = None, xp: float = None):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return

    if level is None and xp is None:
        await interaction.response.send_message(
            "You must specify at least one of the following: level or XP.",
            ephemeral=True,
        )
        return

    guild_id = interaction.guild.id
    user_id = user.id

    try:
        # Calculate XP if a new level is provided
        if level is not None:
            base_xp = 100  # Replace this with your dynamic base XP if necessary
            xp = (level ** 2) * base_xp

        # Calculate level if only XP is provided
        if xp is not None:
            base_xp = 100  # Replace this with your dynamic base XP if necessary
            level = int((xp / base_xp) ** 0.5)

        # Update the user's XP in the database
        c.execute(
            "INSERT INTO user_xp (user_id, guild_id, xp) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET xp = ?",
            (user_id, guild_id, xp, xp),
        )
        conn.commit()

        # Assign roles based on the new level
        await assign_roles(user, level, interaction.guild)

        await interaction.response.send_message(
            f"Successfully updated {user.mention}'s level to {level} and XP to {xp:.2f}.",
            ephemeral=False,
        )

    except Exception as e:
        print(f"Error editing user level: {e}")
        await interaction.response.send_message(
            "An error occurred while editing the user's level. Please try again later.",
            ephemeral=True,
        )
@bot.tree.command(
    name="clear_guild_data",
    description="Clear all level role mappings and user data from this server."
)
async def clear_guild_data(interaction: discord.Interaction):
    try:
        guild_id = interaction.guild.id

        # Delete level-role mappings for the guild
        c.execute("DELETE FROM level_roles WHERE guild_id = ?", (guild_id,))
        conn.commit()

        # Delete user XP data for the guild
        c.execute("DELETE FROM user_xp WHERE guild_id = ?", (guild_id,))
        conn.commit()

        # Delete user activity data (cooldowns) for the guild
        c.execute("DELETE FROM user_activity WHERE guild_id = ?", (guild_id,))
        conn.commit()

        await interaction.response.send_message(
            f"Successfully cleared all data (level roles and user data) for this server.",
            ephemeral=False,
        )
    except Exception as e:
        print(f"Error clearing guild data: {e}")
        await interaction.response.send_message(
            "An error occurred while clearing data. Please try again later.",
            ephemeral=True,
        )

c.execute('''
CREATE TABLE IF NOT EXISTS sync_guilds (
    guild_id INTEGER PRIMARY KEY
)
''')
conn.commit()

@bot.tree.command(
    name="addsyncguild",
    description="Add a guild to the XP sync list."
)
@app_commands.describe(guild_id="The ID of the guild to add to the sync list.")
async def addsyncguild(interaction: discord.Interaction, guild_id: str):
    # Check if the user is an admin
    if not is_admin(interaction):
        await interaction.response.send_message(
            "You must be an administrator to use this command.", ephemeral=True
        )
        return

    # Add the guild to the sync list
    guild_id = int(guild_id)
    c.execute("INSERT OR IGNORE INTO sync_guilds (guild_id) VALUES (?)", (guild_id,))
    conn.commit()
    await interaction.response.send_message(
        f"Guild with ID {guild_id} has been added to the XP sync list.", ephemeral=False
    )

@bot.tree.command(
    name="remove_sync_guild",
    description="Remove a guild from the XP sync list."
)
@app_commands.describe(guild_id="The ID of the guild to remove from the sync list.")
async def remove_sync_guild(interaction: discord.Interaction, guild_id: str):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "You need to be an administrator to use this command.", ephemeral=True
        )
        return

    try:
        guild_id = int(guild_id)
        c.execute("DELETE FROM sync_guilds WHERE guild_id = ?", (guild_id,))
        conn.commit()
        await interaction.response.send_message(
            f"Guild with ID {guild_id} has been removed from the XP sync list.", ephemeral=False
        )
    except ValueError:
        await interaction.response.send_message(
            "Invalid guild ID. Please provide a valid numeric guild ID.", ephemeral=True
        )

@bot.tree.command(
    name="view_synced_guilds",
    description="View all guilds synced for XP synchronization."
)
async def view_synced_guilds(interaction: discord.Interaction):
    """
    Display the list of synced guilds as an embed with their names, IDs, and icons.
    """
    # Fetch synced guild IDs from the database
    c.execute("SELECT guild_id FROM sync_guilds")
    sync_guilds = [row[0] for row in c.fetchall()]

    if not sync_guilds:
        await interaction.response.send_message("No guilds are currently synced for XP synchronization.", ephemeral=True)
        return

    embed = discord.Embed(
        title="Synced Guilds",
        description="The following guilds are synced for XP synchronization:",
        color=discord.Color.blue()
    )

    # Add each guild to the embed
    for guild_id in sync_guilds:
        guild = bot.get_guild(guild_id)
        if guild:
            embed.add_field(
                name=guild.name,
                value=f"ID: `{guild.id}`",
                inline=False
            )
            if guild.icon:
                embed.set_thumbnail(url=guild.icon.url)

    await interaction.response.send_message(embed=embed)
@tasks.loop(minutes=30)  # Adjust the interval as needed
async def sync_xp_across_selected_guilds():
    """
    Sync user XP across selected guilds that are in the sync list.
    """
    try:
        # Get the list of guilds to sync
        c.execute("SELECT guild_id FROM sync_guilds")
        sync_guilds = [row[0] for row in c.fetchall()]

        if not sync_guilds:
            print("No guilds to sync.")
            return

        # Consolidate XP and level for users across the selected guilds
        c.execute(""" 
            SELECT user_id, MAX(xp) as max_xp
            FROM user_xp
            WHERE guild_id IN ({} )
            GROUP BY user_id
        """.format(", ".join(["?"] * len(sync_guilds))), sync_guilds)
        user_xp_data = c.fetchall()

        if not user_xp_data:
            print("No user XP data found to sync.")
            return

        for user_id, max_xp in user_xp_data:
            # Calculate the level based on the max XP
            base_xp = 100  # Replace with dynamic base XP if needed
            max_level = int((max_xp / base_xp) ** 0.5)

            print(f"Syncing user {user_id} with level {max_level} and XP {max_xp}.")

            # Update XP and level in all selected guilds
            for guild_id in sync_guilds:
                # Insert or update the user's XP for the current guild
                c.execute(
                    "INSERT INTO user_xp (user_id, guild_id, xp) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET xp = ?",
                    (user_id, guild_id, max_xp, max_xp),
                )
                
                # Get the guild object
                guild = bot.get_guild(guild_id)
                if guild:
                    try:
                        # Attempt to fetch the member explicitly
                        member = await guild.fetch_member(user_id)
                        print(f"Assigning roles for {member.display_name} in guild {guild.name}.")
                        await assign_roles(member, max_level, guild)
                    except discord.NotFound:
                        print(f"Member {user_id} not found in guild {guild.name}.")
                    except discord.Forbidden:
                        print(f"Bot doesn't have permission to view member {user_id} in guild {guild.name}.")
                    except discord.HTTPException as e:
                        print(f"An error occurred while fetching member {user_id} in guild {guild.name}: {e}")
        
        # Commit the changes to the database
        conn.commit()
        print("XP synchronization across selected guilds completed successfully.")

    except Exception as e:
        print(f"Error during XP synchronization: {e}")

@bot.tree.command(
    name="force_sync",
    description="Manually synchronize XP and levels across all selected guilds."
)
async def force_sync(interaction: discord.Interaction):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "You need to be an administrator to use this command.", ephemeral=True
        )
        return

    try:
        await interaction.response.defer(ephemeral=False)  # Defer the response since it may take time

        # Get the list of guilds to sync
        c.execute("SELECT guild_id FROM sync_guilds")
        sync_guilds = [row[0] for row in c.fetchall()]

        if not sync_guilds:
            await interaction.followup.send("No guilds are currently in the XP sync list.")
            return

        print(f"Syncing guilds: {sync_guilds}")

        # Consolidate XP and level for users across the selected guilds
        c.execute("""
            SELECT user_id, MAX(xp) as max_xp
            FROM user_xp
            WHERE guild_id IN ({})
            GROUP BY user_id
        """.format(", ".join(["?"] * len(sync_guilds))), sync_guilds)
        user_xp_data = c.fetchall()

        if not user_xp_data:
            await interaction.followup.send("No user XP data found to sync.")
            return

        print(f"Fetched user XP data: {user_xp_data}")

        for user_id, max_xp in user_xp_data:
            # Calculate the level based on the max XP
            base_xp = 100  # Replace with dynamic base XP if needed
            max_level = int((max_xp / base_xp) ** 0.5)

            print(f"Syncing user {user_id} with level {max_level} and XP {max_xp}.")

            # Update XP and level in all selected guilds
            for guild_id in sync_guilds:
                # Insert or update the user's XP for the current guild
                c.execute(
                    "INSERT INTO user_xp (user_id, guild_id, xp) VALUES (?, ?, ?) ON CONFLICT (user_id, guild_id) DO UPDATE SET xp = ?",
                    (user_id, guild_id, max_xp, max_xp),
                )

                # Get the guild object
                guild = bot.get_guild(guild_id)
                if guild:
                    try:
                        # Attempt to fetch the member explicitly
                        member = await guild.fetch_member(user_id)
                        print(f"Assigning roles for {member.display_name} in guild {guild.name}.")
                        await assign_roles(member, max_level, guild)
                    except discord.NotFound:
                        print(f"Member {user_id} not found in guild {guild.name}.")
                    except discord.Forbidden:
                        print(f"Bot doesn't have permission to view member {user_id} in guild {guild.name}.")
                    except discord.HTTPException as e:
                        print(f"An error occurred while fetching member {user_id} in guild {guild.name}: {e}")
        
        # Commit the changes to the database
        conn.commit()
        await interaction.followup.send("XP synchronization across selected guilds has been completed successfully!")

    except Exception as e:
        print(f"Error during manual XP synchronization: {e}")
        await interaction.followup.send(
            "An error occurred during synchronization. Please try again later.",
            ephemeral=True,
        )

    
@bot.tree.command(
    name="myprofile",
    description="View your current level, XP, and progress to the next level."
)
async def myprofile(interaction: discord.Interaction):
    """
    Display the user's current level, XP, and progress toward the next level with a progress bar.
    """
    user_id = interaction.user.id
    guild_id = interaction.guild.id

    try:
        # Fetch the user's current XP from the database
        c.execute("SELECT xp FROM user_xp WHERE user_id = ? AND guild_id = ?", (user_id, guild_id))
        result = c.fetchone()

        if not result:
            await interaction.response.send_message(
                "You haven't earned any XP yet. Start participating to gain XP and level up!", ephemeral=True
            )
            return

        current_xp = result[0]

        # Base XP (adjust dynamically if needed)
        base_xp = 100

        # Calculate current level
        current_level = int((current_xp / base_xp) ** 0.5)

        # XP needed for the next level
        next_level = current_level + 1
        xp_for_next_level = (next_level ** 2) * base_xp
        xp_to_next_level = xp_for_next_level - current_xp

        # Progress percentage
        progress_percentage = (current_xp - (current_level ** 2) * base_xp) / ((next_level ** 2) * base_xp - (current_level ** 2) * base_xp)
        progress_percentage = min(max(progress_percentage, 0), 1)  # Clamp between 0 and 1

        # Generate a progress bar
        progress_bar_length = 20  # Length of the bar
        filled_length = int(progress_percentage * progress_bar_length)
        progress_bar = "█" * filled_length + "░" * (progress_bar_length - filled_length)

        # Estimate number of messages to level up (assuming average XP per message)
        avg_xp_per_message = 3.0  # Adjust this based on your XP range (e.g., 1.0 to 5.0)
        messages_to_next_level = int(xp_to_next_level / avg_xp_per_message)

        # Create an embed for the user
        embed = discord.Embed(
            title=f"{interaction.user.display_name}'s Profile",
            description=f"Level Progress: **{current_level} → {next_level}**",
            color=discord.Color.blue()
        )
        embed.add_field(name="Current Level", value=f"{current_level}", inline=True)
        embed.add_field(name="Next Level", value=f"{next_level}", inline=True)
        embed.add_field(name="Progress", value=f"`{progress_bar}`", inline=False)
        embed.add_field(name="Current XP", value=f"{int(current_xp)}", inline=True)
        embed.add_field(name="XP Needed", value=f"{int(xp_to_next_level)}", inline=True)
        embed.add_field(name="Estimated Messages", value=f"{messages_to_next_level} messages", inline=False)
        embed.set_thumbnail(url=interaction.user.display_avatar.url)
        embed.set_footer(text="Keep participating to level up! You're doing great!")

        await interaction.response.send_message(embed=embed)

    except Exception as e:
        print(f"Error in /myprofile command: {e}")
        await interaction.response.send_message(
            "An error occurred while retrieving your profile. Please try again later.", ephemeral=True
        )

from discord import ui
from discord import SelectOption, app_commands, ButtonStyle
from discord.ui import View, Select, Button

class AssignMultipleCommandsView(View):
    def __init__(self, command_names, roles):
        super().__init__()
        self.selected_commands = []
        self.selected_role = None

        # Dropdown for commands (multiple selection allowed)
        self.command_select = Select(
            placeholder="Select commands...",
            options=[
                SelectOption(label=command_name, value=command_name)
                for command_name in command_names
            ],
            min_values=1,  # Minimum number of commands to select
            max_values=len(command_names),  # Maximum number of commands
        )
        self.command_select.callback = self.select_commands
        self.add_item(self.command_select)

        # Dropdown for roles
        self.role_select = Select(
            placeholder="Select a role...",
            options=[
                SelectOption(label=role.name, value=str(role.id))
                for role in roles
            ],
            min_values=1,
            max_values=1,  # Only one role can be selected
        )
        self.role_select.callback = self.select_role
        self.add_item(self.role_select)

        # Submit button
        self.submit_button = Button(label="Submit", style=ButtonStyle.green)
        self.submit_button.callback = self.submit
        self.add_item(self.submit_button)

    async def select_commands(self, interaction: discord.Interaction):
        self.selected_commands = self.command_select.values
        await interaction.response.defer()

    async def select_role(self, interaction: discord.Interaction):
        self.selected_role = self.role_select.values[0]
        await interaction.response.defer()

    async def submit(self, interaction: discord.Interaction):
        if not self.selected_commands or not self.selected_role:
            await interaction.response.send_message(
                "Please select at least one command and a role before submitting.",
                ephemeral=True
            )
            return

        # Save to the database for all selected commands
        guild_id = interaction.guild.id
        for command_name in self.selected_commands:
            c.execute("""
                INSERT INTO command_roles (guild_id, command_name, role_id)
                VALUES (?, ?, ?)
                ON CONFLICT (guild_id, command_name) DO UPDATE SET role_id = ?
            """, (guild_id, command_name, int(self.selected_role), int(self.selected_role)))
        conn.commit()

        await interaction.response.send_message(
            f"Role `{self.selected_role}` has been assigned to commands `{', '.join(self.selected_commands)}` successfully.",
            ephemeral=True
        )

@bot.tree.command(
    name="assign_command_role",
    description="Assign a role to multiple commands using dropdown menus."
)
async def assign_command_role(interaction: discord.Interaction):
    """
    Display a view to assign a role to multiple commands.
    """
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "You need to be an administrator to use this command.", ephemeral=True
        )
        return

    # Fetch all registered commands dynamically
    command_names = [command.name for command in bot.tree.get_commands()]

    # Fetch roles dynamically from the guild
    roles = interaction.guild.roles

    # Create and send the view
    view = AssignMultipleCommandsView(command_names, roles)
    await interaction.response.send_message(
        "Please select commands and a role to assign:", view=view
    )


@bot.tree.command(
    name="view_command_roles",
    description="View all roles assigned to commands for this guild."
)
async def view_command_roles(interaction: discord.Interaction):
    """
    Display the roles assigned to each command in the guild.
    """
    # Check if the user is an admin
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "You need to be an administrator to use this command.", ephemeral=True
        )
        return

    guild_id = interaction.guild.id

    # Fetch the roles assigned to commands in this guild
    c.execute("SELECT command_name, role_id FROM command_roles WHERE guild_id = ?", (guild_id,))
    roles = c.fetchall()

    if not roles:
        await interaction.response.send_message(
            "No roles have been assigned to commands in this guild.", ephemeral=True
        )
        return

    response = "\n".join([f"Command: `{row[0]}`, Role ID: `{row[1]}`" for row in roles])
    await interaction.response.send_message(f"Roles assigned to commands:\n{response}", ephemeral=False)

from discord import Embed, SelectOption, ButtonStyle
from discord.ui import View, Select, Button

class RemoveCommandRoleView(View):
    def __init__(self, command_names):
        super().__init__()
        self.selected_command = None

        # Dropdown for commands
        self.command_select = Select(
            placeholder="Select a command to remove its assigned role...",
            options=[
                SelectOption(label=command_name, value=command_name)
                for command_name in command_names
            ],
            min_values=1,
            max_values=1,  # Only one command can be selected
        )
        self.command_select.callback = self.select_command
        self.add_item(self.command_select)

        # Submit button
        self.submit_button = Button(label="Submit", style=ButtonStyle.green)
        self.submit_button.callback = self.submit
        self.add_item(self.submit_button)

        # Cancel button
        self.cancel_button = Button(label="Cancel", style=ButtonStyle.red)
        self.cancel_button.callback = self.cancel
        self.add_item(self.cancel_button)

    async def select_command(self, interaction: discord.Interaction):
        self.selected_command = self.command_select.values[0]
        await interaction.response.defer()

    async def submit(self, interaction: discord.Interaction):
        if not self.selected_command:
            await interaction.response.send_message(
                "Please select a command before submitting.", ephemeral=True
            )
            return

        # Remove the role assignment for the selected command
        guild_id = interaction.guild.id
        c.execute("DELETE FROM command_roles WHERE guild_id = ? AND command_name = ?", (guild_id, self.selected_command))
        conn.commit()

        # Send confirmation
        embed = Embed(
            title="Role Removed Successfully",
            description=f"The role assigned to the command `{self.selected_command}` has been removed.",
            color=0xFF0000,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    async def cancel(self, interaction: discord.Interaction):
        await interaction.response.send_message(
            "Command role removal has been canceled.", ephemeral=True
        )
        self.stop()


@bot.tree.command(
    name="remove_command_role",
    description="Remove a role assignment from a command."
)
async def remove_command_role(interaction: discord.Interaction):
    """
    Display a UI to remove a role assignment from a command.
    """
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "You need to be an administrator to use this command.", ephemeral=True
        )
        return

    # Fetch commands that have assigned roles in this guild
    guild_id = interaction.guild.id
    c.execute("SELECT command_name FROM command_roles WHERE guild_id = ?", (guild_id,))
    rows = c.fetchall()

    if not rows:
        await interaction.response.send_message(
            "No commands currently have assigned roles in this server.", ephemeral=True
        )
        return

    # Create a view with the commands
    command_names = [row[0] for row in rows]
    view = RemoveCommandRoleView(command_names)

    # Send the view
    embed = Embed(
        title="Remove Command Role",
        description="Select a command from the dropdown menu to remove its assigned role.",
        color=0x3498DB,
    )
    await interaction.response.send_message(embed=embed, view=view)


def has_required_role(interaction: discord.Interaction, command_name: str) -> bool:
    """
    Check if the user has one of the roles required to execute a command.
    """
    guild_id = interaction.guild.id
    user_roles = [role.id for role in interaction.user.roles]

    # Fetch the allowed role for the command in the guild
    c.execute("SELECT role_id FROM command_roles WHERE guild_id = ? AND command_name = ?", (guild_id, command_name))
    result = c.fetchone()

    if result:
        required_role_id = result[0]
        return required_role_id in user_roles

    # If no role restriction is set, allow the command
    return True


# Run the bot
bot.run("12345678")
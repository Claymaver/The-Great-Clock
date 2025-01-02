import discord
from discord.ext import commands
from discord import app_commands
import sqlite3
import random
import time

# Set up bot
intents = discord.Intents.default()
intents.messages = True
intents.guilds = True
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

# Connect to SQLite database
conn = sqlite3.connect('leveling.db')
c = conn.cursor()

# Create tables
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
conn.commit()

# Functions for managing XP and levels
def calculate_level(new_xp, guild_id):
    c.execute('SELECT base_xp, formula FROM leveling_settings WHERE guild_id = ?', (guild_id,))
    result = c.fetchone()
    base_xp = result[0] if result else 100
    formula = result[1] if result else 'square_root'

    if formula == 'square_root':
        return int((new_xp / base_xp) ** 0.5)
    elif formula == 'linear':
        return int(new_xp / base_xp)
    elif formula == 'custom':
        return int((new_xp / base_xp) ** 0.8)
    return int((new_xp / base_xp) ** 0.5)

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

async def assign_roles(member, new_level, guild):
    c.execute('SELECT level, role_id FROM level_roles WHERE guild_id = ?', (guild.id,))
    roles = c.fetchall()
    for level, role_id in roles:
        role = guild.get_role(role_id)
        if role:
            if new_level >= level:
                await member.add_roles(role)
            else:
                await member.remove_roles(role)

# Events
@bot.event
async def on_ready():
    print(f'Bot connected as {bot.user}')
    try:
        synced = await bot.tree.sync()
        print(f"Slash commands synced: {len(synced)} commands.")
    except Exception as e:
        print(f"Failed to sync commands: {e}")

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

@bot.tree.command(name="set_leveling_formula", description="Set the formula for leveling.")
@app_commands.describe(formula="The formula for leveling (square_root, linear, custom).")
async def set_leveling_formula(interaction: discord.Interaction, formula: str):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return
    valid_formulas = ['square_root', 'linear', 'custom']
    if formula not in valid_formulas:
        await interaction.response.send_message(f"Invalid formula. Choose from: {', '.join(valid_formulas)}.", ephemeral=True)
        return
    guild_id = interaction.guild.id
    c.execute('''
    INSERT INTO leveling_settings (guild_id, formula)
    VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET formula = ?
    ''', (guild_id, formula, formula))
    conn.commit()
    await interaction.response.send_message(f"Leveling formula has been set to '{formula}'.")

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

@bot.tree.command(name="view_leveling_settings", description="View the leveling settings for this server.")
async def view_leveling_settings(interaction: discord.Interaction):
    guild_id = interaction.guild.id
    c.execute('SELECT base_xp, formula, cooldown FROM leveling_settings WHERE guild_id = ?', (guild_id,))
    result = c.fetchone()
    if result:
        base_xp, formula, cooldown = result
        await interaction.response.send_message(f"Leveling settings:\nBase XP: {base_xp}\nFormula: {formula}\nCooldown: {cooldown} seconds.")
    else:
        await interaction.response.send_message("No custom leveling settings found. Default values are being used.")

@bot.tree.command(name="assign_level_role", description="Assign a role for a specific level.")
@app_commands.describe(level="The level to assign this role to.", role="The role to assign.")
async def assign_level_role(interaction: discord.Interaction, level: int, role: discord.Role):
    if not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("You need to be an administrator to use this command.", ephemeral=True)
        return
    if level <= 0:
        await interaction.response.send_message("Level must be a positive number.", ephemeral=True)
        return
    guild_id = interaction.guild.id
    c.execute('''
    INSERT INTO level_roles (guild_id, level, role_id)
    VALUES (?, ?, ?)
    ON CONFLICT (guild_id, level) DO UPDATE SET role_id = ?
    ''', (guild_id, level, role.id, role.id))
    conn.commit()
    await interaction.response.send_message(f"Role '{role.name}' has been assigned to level {level}")

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



# Run the bot
bot.run("MTMyNDI4NTQ0MDI2NTgxNDAyNg.GkWjly.1hIrBaLgMYTBo_DSdDaEMtD_zms7-CUX9PPYaI")
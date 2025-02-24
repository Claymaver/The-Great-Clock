const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder, PermissionFlagsBits,EmbedBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder,StringSelectMenuBuilder,ButtonBuilder,ButtonStyle,ChannelType, PermissionsBitField, ActivityType, Events } = require('discord.js');require('dotenv').config();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildModeration,
        ],
    });

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Initialize Database
const db = new Database('leveling.db', { verbose: console.log }); 
db.exec(`
    CREATE TABLE IF NOT EXISTS user_xp (
        user_id TEXT PRIMARY KEY,
        xp REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS level_roles (
        level INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (level, guild_id)
    );

    CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    base_xp INTEGER DEFAULT 300,
    multiplier REAL DEFAULT 1.2,
    log_channel TEXT DEFAULT NULL
);
    CREATE TABLE IF NOT EXISTS global_bans (
        user_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT 'No reason provided',
        expires_at INTEGER -- NULL for permanent bans
);
    CREATE TABLE IF NOT EXISTS command_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        UNIQUE(guild_id, role_id)
);
    CREATE TABLE IF NOT EXISTS channel_links (
        source_channel_id TEXT PRIMARY KEY,
        target_channel_id TEXT NOT NULL,
        embed_color TEXT DEFAULT '00AE86'
);
    CREATE TABLE IF NOT EXISTS autopublish_channels (
    channel_id TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT 1
);
    CREATE TABLE IF NOT EXISTS global_timeouts (
    user_id TEXT PRIMARY KEY,
    expires_at INTEGER,
    reason TEXT
    );
    CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS new_user_alerts (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
);
`);

// Initialize Shop Database
const shopDB = new Database('shop.db', { verbose: console.log });

//  Ensure `shop_items` & `user_inventory` exist
shopDB.exec(`
    CREATE TABLE IF NOT EXISTS shop_items (
        item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price INTEGER NOT NULL,
        category TEXT NOT NULL,
        image_url TEXT
    );
    
    CREATE TABLE IF NOT EXISTS user_inventory (
        user_id TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES shop_items(item_id)
    );
    CREATE TABLE IF NOT EXISTS user_currency (
        user_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS jackpot (
        id INTEGER PRIMARY KEY CHECK (id = 1), 
        amount INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS deathbattle_stats (
    user_id TEXT PRIMARY KEY,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0
);

`);

function checkCommandPermission(interaction) {
    // Return true if user is an administrator
    if (interaction.member.permissions.has("Administrator")) {
        return true;
    }

    // Return false if not in a guild or if member/roles are undefined
    if (!interaction.guild || !interaction.member || !interaction.member.roles) {
        return false;
    }

    const guildId = interaction.guild.id;
    const memberRoles = interaction.member.roles.cache.map(role => role.id);

    try {
        // Fetch allowed roles for the guild
        const allowedRoles = db.prepare(`
            SELECT role_id FROM command_roles WHERE guild_id = ?
        `).all(guildId);

        // If no roles are set for the guild, assume all commands are restricted
        if (allowedRoles.length === 0) {
            return false;
        }

        // Check if the member has any of the allowed roles
        const allowedRoleIds = allowedRoles.map(row => row.role_id);
        return memberRoles.some(roleId => allowedRoleIds.includes(roleId));

    } catch (error) {
        console.error('Error checking command permissions:', error);
        return false; // Return false on error to be safe
    }
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Ensure Guild Settings
function ensureGuildSettings() {
    db.prepare(`
        INSERT INTO guild_settings (guild_id, base_xp, multiplier, log_channel)
        VALUES ('global', 300, 1.2, NULL)
        ON CONFLICT(guild_id) DO NOTHING
    `).run();
}

// Calculate the level based on XP
function calculateLevel(xp, baseXp, multiplier) {
    let level = 1;
    let xpForCurrentLevel = baseXp; // Start with base XP for level 1

    while (xp >= xpForCurrentLevel) {
        xp -= xpForCurrentLevel; // Subtract XP required for the current level
        level++;
        xpForCurrentLevel = Math.ceil(baseXp * Math.pow(multiplier, level - 1)); // Exponential growth for each level
    }

    return level;
}

// Register the command with the Discord API
client.application?.commands.create(manageCommandRolesCommand.toJSON());

// Calculate XP required for a specific level
function calculateTotalXpForLevel(level, baseXp, multiplier) {
    let totalXp = 0;

    for (let i = 1; i < level; i++) {
        totalXp += baseXp * Math.pow(multiplier, i - 1); // XP for each level
    }

    return totalXp;
}

// Max Listeners for interactions
client.setMaxListeners(50);

// Commands
const commands = [
        // ===============================
        // ⚡ XP & Leveling Commands
        // ===============================
        new SlashCommandBuilder()
            .setName("tgc-profile")
            .setDescription("View your profile or another user's profile.")
            .addUserOption(option =>
                option.setName("user")
                    .setDescription("The user whose profile you want to view.")
                    .setRequired(false)),
    
        new SlashCommandBuilder()
            .setName("tgc-setxp")
            .setDescription("Set a user's global XP or level manually.")
            .addUserOption(option =>
                option.setName("user")
                    .setDescription("The user whose global XP or level you want to set.")
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName("xp")
                    .setDescription("The global XP amount to set."))
            .addIntegerOption(option =>
                option.setName("level")
                    .setDescription("The level to set (overrides XP).")),
    
        new SlashCommandBuilder()
            .setName("tgc-setbasexp")
            .setDescription("Set the base XP value for leveling.")
            .addIntegerOption(option =>
                option.setName("value")
                    .setDescription("The new base XP value.")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-setmultiplier")
            .setDescription("Set the XP multiplier for leveling.")
            .addNumberOption(option =>
                option.setName("value")
                    .setDescription("The multiplier (default: 1.2).")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-setlevelrole")
            .setDescription("Set a role to be applied when a user reaches a specific level.")
            .addIntegerOption(option =>
                option.setName("level")
                    .setDescription("The level at which the role will be applied.")
                    .setRequired(true))
            .addRoleOption(option =>
                option.setName("role")
                    .setDescription("The role to assign.")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-importuserdata")
            .setDescription("Import user data from a JSON file to update XP.")
            .addAttachmentOption(option =>
                option.setName("file")
                    .setDescription("The JSON file to import user data from.")
                    .setRequired(true)),
        new SlashCommandBuilder()
                .setName("tgc-xpleaderboard")
                .setDescription("View the top XP leaderboard."),
                    
        new SlashCommandBuilder()
                .setName("tgc-battleleaderboard")
                .setDescription("View the top players in Death Battle."),
    
        // ===============================
        // 🔧 Moderation & Management Commands
        // ===============================
new SlashCommandBuilder()
    .setName("tgc-ban")
    .setDescription("Globally ban a user.")
    .addUserOption(option =>
        option.setName("user")
            .setDescription("The user to ban.")
            .setRequired(true))
    .addStringOption(option =>
        option.setName("reason")
            .setDescription("Reason for the ban.")
            .setRequired(false))
    .addIntegerOption(option =>
        option.setName("days")
            .setDescription("Number of days for the ban duration.")
            .setMinValue(0)
            .setRequired(false))
    .addIntegerOption(option =>
        option.setName("hours")
            .setDescription("Number of hours for the ban duration.")
            .setMinValue(0)
            .setRequired(false))
    .addIntegerOption(option =>
        option.setName("minutes")
            .setDescription("Number of minutes for the ban duration.")
            .setMinValue(0)
            .setRequired(false))
    .addIntegerOption(option =>
        option.setName("delete_messages")
            .setDescription("Delete messages from the last X days (0-14).")
            .setMinValue(0)
            .setMaxValue(14)
            .setRequired(false)),
    
        new SlashCommandBuilder()
            .setName("tgc-kick")
            .setDescription("Globally kick a user.")
            .addUserOption(option =>
                option.setName("user")
                    .setDescription("The user to kick.")
                    .setRequired(true))
            .addStringOption(option =>
                option.setName("reason")
                    .setDescription("Reason for the kick.")
                    .setRequired(false)),
    
        new SlashCommandBuilder()
            .setName("tgc-banlist")
            .setDescription("View the list of globally banned users."),
    
        new SlashCommandBuilder()
            .setName("tgc-unban")
            .setDescription("Search and unban users.")
            .addStringOption(option =>
                option.setName("search")
                    .setDescription("Search by username or ID")
                    .setRequired(true)
            ),

        new SlashCommandBuilder()
            .setName("tgc-timeout")
            .setDescription("Timeout a user across all servers.")
            .addUserOption(option =>
                option.setName("user")
                    .setDescription("The user to timeout.")
                    .setRequired(true))
            .addStringOption(option =>
                option.setName("duration")
                    .setDescription("Timeout duration (e.g., 1d 2h 30m) or 0 to remove.")
                    .setRequired(true))
            .addStringOption(option =>
                option.setName("reason")
                    .setDescription("Reason for the timeout.")
                    .setRequired(false)),
    
        new SlashCommandBuilder()
            .setName("tgc-lock")
            .setDescription("Locks or unlocks a channel (toggle).")
            .addChannelOption(option => 
                option.setName("channel")
                    .setDescription("The channel to lock/unlock.")
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('tgc-managecommandroles')
            .setDescription('Manage roles that can use TGC commands')
            .addStringOption(option =>
                option.setName('action')
                    .setDescription('Choose whether to add or remove a role')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Add Role', value: 'add' },
                        { name: 'Remove Role', value: 'remove' }
                    )
            )
            .addRoleOption(option =>
                option.setName('role')
                    .setDescription('The role to add or remove')
                    .setRequired(true)
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
           
            new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete all messages from a user in the server.")
    .addUserOption(option => 
        option.setName("user")
        .setDescription("The user whose messages will be deleted")
        .setRequired(true))
    .addChannelOption(option =>
        option.setName("channel")
        .setDescription("The channel to purge messages from (optional)")
        .setRequired(false)),


        // ===============================
        // 📩 Message Management Commands
        // ===============================
        new SlashCommandBuilder()
            .setName("tgc-createembed")
            .setDescription("Start creating an embed message."),
    
        new SlashCommandBuilder()
            .setName("tgc-sendmessage")
            .setDescription("Sends a normal text message using a modal.")
            .addChannelOption(option => 
                option.setName("channel")
                    .setDescription("The channel to send the message in.")
                    .setRequired(true)),
        new SlashCommandBuilder ()
                .setName ("tgc-openticket")
                .setDescription ("opens a support ticket"),
        new SlashCommandBuilder ()
                .setName ("tgc-closeticket")
                .setDescription ("closes a support ticket"),
        new SlashCommandBuilder()
                .setName('tgc-setlogchannel')
                .setDescription('Sets the log channel for this server.')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Select the log channel')
                        .setRequired(true)
                ),
        new SlashCommandBuilder()
                .setName('tgc-setalertchannel')
                .setDescription('Sets the channel for new user alerts')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to send new user alerts to')
                        .setRequired(true)
                ),
        // ===============================
        // 📢 Auto-Publishing & Forwarding Commands
        // ===============================
        new SlashCommandBuilder()
            .setName("tgc-toggleautopublish")
            .setDescription("Enable or disable auto-publishing for an announcement channel.")
            .addChannelOption(option =>
                option.setName("channel")
                    .setDescription("The announcement channel to toggle auto-publishing for.")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-forward")
            .setDescription("Set up message forwarding between two channels.")
            .addStringOption(option =>
                option.setName("source_id")
                    .setDescription("Source channel ID (where messages are forwarded from).")
                    .setRequired(true))
            .addStringOption(option =>
                option.setName("target_id")
                    .setDescription("Target channel ID (where messages will be sent).")
                    .setRequired(true))
            .addStringOption(option =>
                option.setName("color")
                    .setDescription("Embed color (e.g., 'Red', 'Light Blue', 'Green').")
                    .setRequired(false)),
    
        new SlashCommandBuilder()
            .setName("tgc-removeforward")
            .setDescription("Remove message forwarding from a source channel.")
            .addStringOption(option =>
                option.setName("source_id")
                    .setDescription("Source channel ID to remove from forwarding.")
                    .setRequired(true)),
    
        // ===============================
        // 🎮 Fun Commands
        // ===============================
        new SlashCommandBuilder()
            .setName("tgc-deathbattle")
            .setDescription("Start a death battle between two users!")
            .addUserOption(option =>
                option.setName("fighter1")
                    .setDescription("First fighter.")
                    .setRequired(true))
            .addUserOption(option =>
                option.setName("fighter2")
                    .setDescription("Second fighter.")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-8ball")
            .setDescription("Ask the magic 8-ball a question.")
            .addStringOption(option =>
                option.setName("question")
                    .setDescription("Your yes/no question.")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-randomquote")
            .setDescription("Fetches a random quote from the database."),
    
        new SlashCommandBuilder()
            .setName("tgc-addquote")
            .setDescription("Adds a new quote to the database using a modal."),
    
        new SlashCommandBuilder()
            .setName("tgc-listquotes")
            .setDescription("Lists all stored quotes with IDs."),
    
        new SlashCommandBuilder()
            .setName("tgc-deletequote")
            .setDescription("Deletes a quote from the database.")
            .addIntegerOption(option =>
                option.setName("id")
                    .setDescription("The ID of the quote to delete.")
                    .setRequired(true)),

        // ===============================
        // 💰 Economy & Shop Command
        // ===============================
        
        new SlashCommandBuilder()
            .setName("tgc-balance")
            .setDescription("Check your currency balance or another user's balance.")
            .addUserOption(option => 
                option.setName("user")
                .setDescription("The user whose balance you want to check.")
                .setRequired(false)),

        new SlashCommandBuilder()
            .setName("tgc-give-currency")
            .setDescription("Give currency to a user (Admin only).")
            .addUserOption(option => 
                option.setName("user")
                .setDescription("The user who will receive the currency.")
                .setRequired(true))
            .addIntegerOption(option => 
                option.setName("amount")
                .setDescription("The amount of currency to give.")
                .setRequired(true)),
        new SlashCommandBuilder()
            .setName("tgc-shop")
            .setDescription("Opens the interactive shop interface."),

        new SlashCommandBuilder()
            .setName("tgc-inventory")
            .setDescription("View your inventory or another user's inventory.")
            .addUserOption(option => 
                option.setName("user")
                .setDescription("The user whose inventory you want to check.")
                .setRequired(false)),
        new SlashCommandBuilder()
            .setName("tgc-additem")
            .setDescription("Add a new item to the shop (Admin only).")
            .addStringOption(option => 
                option.setName("name")
                .setDescription("The name of the item.")
                .setRequired(true))
            .addIntegerOption(option => 
                option.setName("price")
                .setDescription("The price of the item in currency.")
                .setRequired(true))
            .addStringOption(option => 
                option.setName("description")
                .setDescription("A short description of the item.")
                .setRequired(true))
            .addStringOption(option => 
                option.setName("category")
                .setDescription("The category for this item.")
                .setRequired(true))
            .addStringOption(option =>
                option.setName("image")
                .setDescription("Optional: Image URL for the item.")
                .setRequired(false)),
    
        new SlashCommandBuilder()
            .setName("tgc-removeitem")
            .setDescription("Remove an item from the shop (Admin only).")
            .addStringOption(option => 
                option.setName("name")
                .setDescription("The name of the item to remove.")
                .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName("tgc-setprice")
            .setDescription("Set or change the price of an item (Admin only).")
            .addStringOption(option => 
                option.setName("item")
                .setDescription("The name of the item.")
                .setRequired(true))
            .addIntegerOption(option => 
                option.setName("new_price")
                .setDescription("The new price of the item.")
                .setRequired(true)),
        
        new SlashCommandBuilder()
            .setName("tgc-giveitem")
            .setDescription("Give an item to a user manually (Admin only).")
            .addUserOption(option => 
                option.setName("user")
                .setDescription("The user who will receive the item.")
                .setRequired(true))
            .addStringOption(option => 
                option.setName("item")
                .setDescription("The name of the item to give.")
                .setRequired(true)),
        // ===============================
        // Gambling Commands
        // ===============================
        new SlashCommandBuilder()
            .setName("tgc-slots")
            .setDescription("Gamble your bolts on the slot machine.")
            .addIntegerOption(option =>
                option.setName("amount")
                    .setDescription("Enter the amount of bolts you want to bet.")
                    .setRequired(true)),
    
        new SlashCommandBuilder()
            .setName("tgc-roulette")
            .setDescription("Gamble your bolts on the roulette wheel.")
            .addIntegerOption(option =>
                option.setName("amount")
                    .setDescription("Enter the amount of bolts you want to bet.")
                    .setRequired(true)),
];

// Register Commands
(async () => {
    try {
        console.log('Registering commands...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands.map(command => command.toJSON()) }
        );
        console.log(`Successfully registered ${commands.length} commands!`);
    } catch (error) {
        console.error("❌ Error registering commands:", error);
    }
})();

// Define color constants
const EMBED_COLORS = {
    "Pink": "eb0062",
    "Red": "ff0000",
    "Dark Red": "7c1e1e",
    "Orange": "ff4800",
    "Yellow": "ffe500",
    "Green": "1aff00",
    "Forest Green": "147839",
    "Light Blue": "00bdff",
    "Dark Blue": "356feb",
    "Purple": "76009a",
    "Default": "00AE86"
};

// ===============================
//        XP & Leveling
// ===============================

// Command Handling
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'tgc-setbasexp') {
        const baseXp = interaction.options.getInteger('value');
        const guildId = interaction.guild?.id;
    
        // Ensure the command is being used in a guild
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used in a server.',
                flags: 64
            });
        }
    
        // Permission Check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
        }
    
        ensureGuildSettings(guildId);
    
        try {
            db.prepare(`
                UPDATE guild_settings SET base_xp = ? WHERE guild_id = ?
            `).run(baseXp, guildId);
    
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Base XP Updated ✅')
                    .setDescription(`Base XP set to **${baseXp}**.`)
                    .setColor('#00FF00')],
            });
        } catch (error) {
            console.error('Error updating Base XP:', error);
            await interaction.reply({
                content: 'Failed to update Base XP.',
                flags: 64
            });
        }
    }
    

    if (commandName === 'tgc-setmultiplier') {
        const multiplier = interaction.options.getNumber('value');
        const guildId = interaction.guild?.id;

    // Ensure the command is being used in a guild
    if (!guildId) {
        return interaction.reply({
            content: 'This command can only be used in a server.',
            flags: 64
        });
    }

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    ensureGuildSettings(guildId);
    
        try {
            db.prepare(`
                UPDATE guild_settings SET multiplier = ? WHERE guild_id = ?
            `).run(multiplier, guildId);
    
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Multiplier Updated ✅')
                    .setDescription(`Multiplier updated to **${multiplier}**.`)
                    .setColor('#00FF00')],
            });
        } catch (error) {
            console.error('Error updating multiplier:', error);
            await interaction.reply({
                content: 'Failed to update multiplier.',
                flags: 64
            });
        }
    }
    

    if (commandName === 'tgc-setxp') {
        const user = interaction.options.getUser('user');
        const xp = interaction.options.getInteger('xp');
        const level = interaction.options.getInteger('level');
        const guildId = interaction.guild?.id;

        // Ensure the command is being used in a guild
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used in a server.',
                flags: 64
            });
        }
    
        // Permission Check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
        }
    
        ensureGuildSettings(guildId);
    
        try {
            // Ensure global settings exist
            ensureGuildSettings();
    
            let finalXp = xp;
    
            // Fetch global settings for XP and multiplier
            const settings = db.prepare(`
                SELECT base_xp, multiplier FROM guild_settings WHERE guild_id = 'global'
            `).get();
    
            if (!settings) {
                throw new Error('Global settings not found. Please ensure the guild settings are initialized.');
            }
    
            const { base_xp: baseXp, multiplier } = settings;
    
            // If level is provided, calculate the corresponding XP
            if (level !== null) {
                if (level <= 0) {
                    throw new Error('Level must be greater than 0.');
                }
                finalXp = calculateTotalXpForLevel(level, baseXp, multiplier);
            }
    
            // Ensure XP is valid
            if (finalXp === null || finalXp < 0) {
                throw new Error('Invalid XP value calculated.');
            }
    
            // Update XP in the database
            db.prepare(`
                INSERT INTO user_xp (user_id, xp)
                VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp
            `).run(user.id, finalXp);
    
            // Calculate the new level
            const newLevel = calculateLevel(finalXp, baseXp, multiplier);
    
            // Send success response
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('XP Updated ✅')
                    .setDescription(`Set XP for **${user.username}** to **${finalXp}**.\nCurrent Level: **${newLevel}**.`)
                    .setColor('#00FF00')],
                flags: 64
            });
        } catch (error) {
            console.error('Error setting XP:', error);
    
            // Send error response
            await interaction.reply({
                content: `Failed to set XP. Error: ${error.message}`,
                flags: 64
            });
        }
    }
    

    if (commandName === 'tgc-setlevelrole') {
        const level = interaction.options.getInteger('level');
        const role = interaction.options.getRole('role');
        const guildId = interaction.guild?.id;

        // Ensure the command is being used in a guild
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used in a server.',
                flags: 64
            });
        }
    
        // Permission Check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
        }
    
        try {
            ensureGuildSettings(guildId);
    
            db.prepare(`
                INSERT INTO level_roles (level, guild_id, role_id)
                VALUES (?, ?, ?)
                ON CONFLICT(level, guild_id) DO UPDATE SET role_id = excluded.role_id
            `).run(level, guildId, role.id);
    
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('Level Role Set ✅')
                    .setDescription(`Role **${role.name}** will now be assigned at level **${level}**.`)
                    .setColor('#00FF00')],
            });
        } catch (error) {
            console.error('Error setting level role:', error);
            await interaction.reply({
                content: 'Failed to set level role. Please try again later.',
                flags: 64
            });
        }
    }
    

    if (commandName === 'tgc-importuserdata') {
        const fileAttachment = interaction.options.getAttachment('file');
        const guildId = interaction.guild?.id;

        // Ensure the command is being used in a guild
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used in a server.',
                flags: 64
            });
        }
        
        ensureGuildSettings(guildId);

    
        // Permission Check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
        }
    
        if (!fileAttachment || !fileAttachment.name.endsWith('.json')) {
            return interaction.reply({
                content: 'Please upload a valid JSON file.',
                flags: 64
            });
        }
    
        await interaction.reply({ content: 'Processing the file... Please wait.', flags: 64 });
    
        try {
            const response = await fetch(fileAttachment.url);
            const fileContent = await response.text();
            const jsonData = JSON.parse(fileContent);
    
            if (!jsonData.users) {
                return interaction.editReply({
                    content: 'The uploaded file does not contain valid user data.',
                });
            }
    
            const insertUserXpStmt = db.prepare(`
                INSERT INTO user_xp (user_id, xp)
                VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp
            `);
    
            // Fetch global settings for XP calculation
            const { base_xp: baseXp, multiplier } = db.prepare(`
                SELECT base_xp, multiplier FROM guild_settings WHERE guild_id = 'global'
            `).get() || { base_xp: 300, multiplier: 1.2 };
    
            let importedCount = 0;
    
            for (const userId in jsonData.users) {
                const userData = jsonData.users[userId];
                const level = userData.level || 1; // Default to level 1 if not provided
    
                // Calculate corresponding XP for the given level
                const totalXp = calculateTotalXpForLevel(level, baseXp, multiplier);
    
                // Insert or update the user's XP in the database
                insertUserXpStmt.run(userId, totalXp);
                importedCount++;
    
                console.log(`Imported User: ${userId}, Level: ${level}, XP: ${totalXp}`);
            }
    
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('User Data Imported Successfully ✅')
                    .setDescription(`Imported data for **${importedCount} users**.`)
                    .setColor('#00FF00')],
            });
        } catch (error) {
            console.error('Error importing user data:', error);
            await interaction.editReply({
                content: 'An error occurred while importing the user data. Please try again later.',
            });
        }
    }
    
    
    if (commandName === 'tgc-profile') {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const userId = targetUser?.id; // Ensure we get a valid user ID
    
        if (!userId) {
            return interaction.reply({ content: 'Could not find the specified user.', flags: 64 });
        }
    
        try {
            // Fetch user XP from the database
            const userXpData = db.prepare(`
                SELECT xp FROM user_xp WHERE user_id = ?
            `).get(userId) || { xp: 0 };
    
            // Fetch global base XP and multiplier
            const { base_xp: baseXp, multiplier } = db.prepare(`
                SELECT base_xp, multiplier FROM guild_settings WHERE guild_id = 'global'
            `).get() || { base_xp: 300, multiplier: 1.2 };
    
            // Calculate Level
            let totalXp = userXpData.xp;
            let level = calculateLevel(totalXp, baseXp, multiplier);
            let xpForCurrentLevel = calculateTotalXpForLevel(level, baseXp, multiplier);
            let xpForNextLevel = calculateTotalXpForLevel(level + 1, baseXp, multiplier);
    
            while (totalXp >= xpForNextLevel) {
                level++;
                xpForCurrentLevel = xpForNextLevel;
                xpForNextLevel = calculateTotalXpForLevel(level + 1, baseXp, multiplier);
            }
    
            // Calculate XP Progress
            const xpProgress = totalXp - xpForCurrentLevel;
            const xpRequired = xpForNextLevel - xpForCurrentLevel;
            const progressBarLength = 20;
            const progressRatio = xpProgress / xpRequired;
            const progressBarFilled = Math.round(progressRatio * progressBarLength);
            const progressBar = '█'.repeat(progressBarFilled) + '░'.repeat(progressBarLength - progressBarFilled);
    
            // Estimate Messages to Level Up
            const averageXpPerMessage = 12; // Adjust as needed
            const messagesToNextLevel = Math.ceil((xpRequired - xpProgress) / averageXpPerMessage);
    
            // Fetch User Avatar Properly
            let avatarURL = targetUser.displayAvatarURL ? targetUser.displayAvatarURL({ dynamic: true }) : null;
            if (!avatarURL) {
                try {
                    const fetchedUser = await client.users.fetch(userId);
                    avatarURL = fetchedUser.displayAvatarURL({ dynamic: true });
                } catch (err) {
                    console.error('Failed to fetch user avatar:', err);
                    avatarURL = 'https://cdn.discordapp.com/embed/avatars/0.png'; // Default avatar
                }
            }
    
            // Build Profile Embed
            const profileEmbed = new EmbedBuilder()
                .setTitle(`${targetUser.username}'s Profile`)
                .setDescription(`Level: **${level}**\nTotal XP: **${totalXp.toFixed(2)}**`)
                .addFields(
                    { name: 'Progress to Next Level', value: `${progressBar} (${xpProgress.toFixed(2)} / ${xpRequired.toFixed(2)} XP)` },
                    { name: 'Messages to Next Level', value: `${messagesToNextLevel} (approx)` }
                )
                .setThumbnail(avatarURL)
                .setColor('#00FF00');
    
            await interaction.reply({ embeds: [profileEmbed], flags: 64 });
    
        } catch (error) {
            console.error('Error generating profile:', error);
            await interaction.reply({
                content: 'An error occurred while generating the profile. Please try again later.',
                flags: 64,
            });
        }
    }    
});

 // ===============================
 //    Moderation & Management
 // ===============================

// Global state management
const tempEmbedData = new Map();

// Rate limiting utility
const rateLimits = new Map();
function checkRateLimit(userId) {
    const now = Date.now();
    const cooldown = 60000; // 1 minute cooldown
    
    if (rateLimits.has(userId)) {
        const lastUse = rateLimits.get(userId);
        if (now - lastUse < cooldown) return false;
    }
    
    rateLimits.set(userId, now);
    return true;
}

// Embed Session
function createEmbedSession(userId) {
    tempEmbedData.set(userId, {
        title: '',
        description: '',
        color: '',
        footer: '',
        image: '',
        thumbnail: '',
        titleLink: '',
        selectedGuild: null,
        selectedChannel: null,
        messageId: null,
        buttonLabel: '',
        buttonUrl: ''
    });
}

// Cleanup function to remove old sessions
function cleanupSessions() {
    const now = Date.now();
    const timeout = 3600000; // 1 hour timeout
    
    tempEmbedData.forEach((session, userId) => {
        if (session.createdAt && now - session.createdAt > timeout) {
            tempEmbedData.delete(userId);
        }
    });
}

// Run cleanup every hour
setInterval(cleanupSessions, 3600000);

client.on('error', error => {
    console.error('Client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Command Handler
client.on("interactionCreate", async (interaction) => {
    try {
        if (!interaction.isCommand() || interaction.commandName !== "tgc-createembed") return;

        const userId = interaction.user.id;

        // Check if user has permission to use this command
        if (!interaction.member.permissions.has('ManageMessages')) {
            return interaction.reply({
                content: "❌ You don't have permission to use this command!",
                flags: 64
            });
        }

        // Rate limit check
        if (!checkRateLimit(userId)) {
            return interaction.reply({ 
                content: "⚠️ Please wait a minute before creating another embed!", 
                flags: 64 
            });
        }

        // Active session check
        if (tempEmbedData.has(userId)) {
            return interaction.reply({ 
                content: "⚠️ You already have an active embed session!", 
                flags: 64 
            });
        }

        // Create new embed session
        createEmbedSession(userId);

        // Get available guilds where bot has permission to send messages
        const guildOptions = interaction.client.guilds.cache
            .filter(guild => {
                const member = guild.members.cache.get(client.user.id);
                return member && member.permissions.has('SendMessages');
            })
            .map(guild => ({
                label: guild.name,
                value: guild.id,
                description: `ID: ${guild.id}`
            }))
            .slice(0, 25);

        if (guildOptions.length === 0) {
            return interaction.reply({ 
                content: "❌ Bot is not in any servers or lacks necessary permissions!", 
                flags: 64 
            });
        }

        // Create server selection dropdown
        const serverDropdown = new StringSelectMenuBuilder()
            .setCustomId(`embed_select_server_${userId}`)
            .setPlaceholder("🌎 Select a Server")
            .addOptions(guildOptions);

        const row = new ActionRowBuilder().addComponents(serverDropdown);

        // Send initial response
        await interaction.reply({
            content: "🌎 **Select a Server to Send the Embed:**",
            components: [row],
            flags: 64
        });

    } catch (error) {
        console.error('Error in create embed command:', error);
        
        // Attempt to reply if we haven't already
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: "❌ An error occurred while creating the embed session.", 
                flags: 64 
            }).catch(console.error);
        }
    }
});

// Server Selection Handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith("embed_select_server_")) return;

    try {
        const userId = interaction.user.id;
        
        // Check if user has an active session
        if (!tempEmbedData.has(userId)) {
            return interaction.reply({ 
                content: "❌ No active embed session found.", 
                flags: 64 
            });
        }

        // Get selected guild
        const guildId = interaction.values[0];
        const guild = interaction.client.guilds.cache.get(guildId);
        
        // Validate guild exists
        if (!guild) {
            return interaction.update({ 
                content: "❌ Server not found or bot no longer has access!", 
                components: [],
                flags: 64 
            });
        }

        // Check bot permissions in the guild
        const botMember = guild.members.cache.get(client.user.id);
        if (!botMember || !botMember.permissions.has(['ViewChannel', 'SendMessages'])) {
            return interaction.update({ 
                content: "❌ Bot doesn't have required permissions in this server!", 
                components: [],
                flags: 64 
            });
        }

        // Update session data
        const sessionData = tempEmbedData.get(userId);
        sessionData.selectedGuild = guildId;
        tempEmbedData.set(userId, sessionData);

        // Get available channels
        const channels = guild.channels.cache
            .filter(channel => 
                channel.isTextBased() && 
                !channel.isThread() && 
                channel.permissionsFor(botMember).has(['SendMessages', 'ViewChannel']) &&
                channel.permissionsFor(interaction.member).has(['SendMessages', 'ViewChannel'])
            )
            .map(channel => ({ 
                label: `#${channel.name}`,
                value: channel.id,
                description: channel.parent ? `Category: ${channel.parent.name}` : 'No Category'
            }))
            .slice(0, 25);

        // Check if any channels are available
        if (channels.length === 0) {
            return interaction.update({ 
                content: "❌ No accessible text channels found in this server.", 
                components: [],
                flags: 64 
            });
        }

        // Create channel selection dropdown
        const channelDropdown = new StringSelectMenuBuilder()
            .setCustomId(`embed_select_channel_${userId}`)
            .setPlaceholder("📢 Select a Channel")
            .addOptions(channels);

        const row = new ActionRowBuilder().addComponents(channelDropdown);

        // Update the message
        await interaction.update({
            content: `✅ **Selected Server:** ${guild.name}\n📢 **Please select a channel:**`,
            components: [row],
            flags: 64
        });

    } catch (error) {
        console.error('Error in server selection:', error);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: "❌ An error occurred while processing server selection.", 
                flags: 64 
            }).catch(console.error);
        } else {
            await interaction.editReply({ 
                content: "❌ An error occurred while processing server selection.", 
                components: [],
                flags: 64 
            }).catch(console.error);
        }
    }
});

// Channel Selection Handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith("embed_select_channel_")) return;

    try {
        const userId = interaction.user.id;
        
        // Check for active session
        if (!tempEmbedData.has(userId)) {
            return interaction.reply({ 
                content: "❌ No active embed session found.", 
                flags: 64 
            });
        }

        const session = tempEmbedData.get(userId);
        const channelId = interaction.values[0];
        
        // Validate channel
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            return interaction.update({ 
                content: "❌ Selected channel not found!", 
                components: [],
                flags: 64 
            });
        }

        // Check if channel is text-based
        if (!channel.isTextBased()) {
            return interaction.update({
                content: "❌ Selected channel must be a text channel!",
                components: [],
                flags: 64
            });
        }

        // Check permissions
        const permissions = channel.permissionsFor(interaction.client.user);
        if (!permissions?.has(['SendMessages', 'ViewChannel', 'EmbedLinks'])) {
            return interaction.update({ 
                content: "❌ Bot doesn't have required permissions in this channel!", 
                components: [],
                flags: 64 
            });
        }

        // Update session data
        session.selectedChannel = channelId;
        tempEmbedData.set(userId, session);

        // Create button rows
        const editButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_set_title_${userId}`)
                .setLabel("📝 Title")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_set_titlelink_${userId}`)
                .setLabel("🔗 Title Link")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_set_description_${userId}`)
                .setLabel("📜 Description")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_set_footer_${userId}`)
                .setLabel("🔽 Footer")
                .setStyle(ButtonStyle.Secondary)
        );

        const imageButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_set_image_${userId}`)
                .setLabel("🖼️ Image")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`embed_set_thumbnail_${userId}`)
                .setLabel("📎 Thumbnail")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`embed_set_color_${userId}`) // Fixed customId
                .setLabel('🎨 Color')
                .setStyle(ButtonStyle.Primary)
        );

        const buttonSettingsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_set_buttonlabel_${userId}`)
                .setLabel("🏷️ Button Label")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`embed_set_buttonurl_${userId}`)
                .setLabel("🔗 Button URL")
                .setStyle(ButtonStyle.Secondary)
        );

        const actionButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_preview_${userId}`)
                .setLabel("👀 Preview")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`embed_send_${userId}`)
                .setLabel("🚀 Send")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`embed_cancel_${userId}`)
                .setLabel("❌ Cancel")
                .setStyle(ButtonStyle.Danger)
        );

        const content = [
            `📢 **Selected Channel:** <#${channelId}>`,
            "✏️ **Customize your embed:**",
            "",
            "**Required Fields:**",
            "• Title or Description",
            "",
            "**Optional Fields:**",
            "• Image/Thumbnail",
            "• Footer",
            "• Color",
            "• Button (Label & URL)"
        ].join('\n');

        await interaction.update({
            content,
            components: [editButtons, imageButtons, buttonSettingsRow, actionButtons],
            flags: 64
        });  

    } catch (error) {
        console.error('Error in channel selection:', error);
        
        const errorMessage = "❌ An error occurred while processing channel selection.";
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: errorMessage, 
                flags: 64 
            }).catch(console.error);
        } else {
            await interaction.editReply({ 
                content: errorMessage, 
                components: [],
                flags: 64 
            }).catch(console.error);
        }
    }
});

// Color selection handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || interaction.customId !== 'selectColor') return;

    try {
        const embedData = tempEmbedData.get(interaction.user.id);
        if (!embedData) {
            return await interaction.reply({
                content: 'No embed data found. Please start over.',
                flags: 64
            });
        }

        await interaction.reply({ 
            content: 'Please enter a color: pink, red, dark red, orange, yellow, green, forest green, light blue, dark blue, purple. (or a hex code #FF0000)',
            flags: 64 
        });

        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ 
            filter, 
            max: 1,
            time: 30000
        });

        collector.on('collect', async message => {
            try {
                await message.delete();
            } catch (err) {
                console.error("Couldn't delete message:", err);
            }

            let color = message.content.toLowerCase();
            if (!color.startsWith('#')) {
                const colorMap = {
                    'pink': '#EB0062',
                    'red': '#FF0000',
                    'dark red': '#7C1E1E',
                    'orange': '#FF4800',
                    'yellow': '#FFE500',
                    'green': '#1AFF00',
                    'forest green': '#147839',
                    'light blue': '#00BDFF',
                    'dark blue': '#356FEB',
                    'purple': '#76009A'
                };
                color = colorMap[color] || color;
            }

            const isValidHex = /^#[0-9A-F]{6}$/i.test(color);
            if (!isValidHex) {
                return await interaction.editReply({ 
                    content: 'Invalid color format! Please use a valid hex code (e.g., #FF0000) or color name.',
                });
            }

            // Update the embed data
            embedData.color = parseInt(color.replace('#', ''), 16);
            tempEmbedData.set(interaction.user.id, embedData);

            await interaction.editReply({
                content: `✅ Color successfully set to: ${color}`,
            });
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.editReply({ 
                    content: '⏰ Color selection timed out. Please try again.',
                });
            }
        });

    } catch (error) {
        console.error('Error:', error);
        if (!interaction.replied) {
            await interaction.reply({ 
                content: '❌ Error processing color selection.',
                flags: 64 
            });
        }
    }
});

// Field Input Handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("embed_set_")) return;

    const userId = interaction.user.id;
    const fieldType = interaction.customId.split("_")[2];

    try {
        // Check for active session
        if (!tempEmbedData.has(userId)) {
            return await interaction.reply({ 
                content: "❌ No active embed session found.", 
                flags: 64
            });
        }

        const session = tempEmbedData.get(userId);

        // Determine prompt message based on field type
        const prompts = {
            'image': "🖼️ **Please provide an image URL or upload an image**\nSupported formats: PNG, JPG, JPEG, GIF, WEBP",
            'thumbnail': "🖼️ **Please provide an image URL or upload an image**\nSupported formats: PNG, JPG, JPEG, GIF, WEBP",
            'titlelink': "🔗 **Please provide the URL for the title:**\nMust be a valid URL starting with http:// or https://",
            'buttonlabel': "✏️ **Enter the label for your button:**",
            'buttonurl': "🔗 **Enter the URL for your button:**\nMust be a valid URL starting with http:// or https://",
            'default': `✏️ **Enter your ${fieldType}:**`
        };

        await interaction.reply({ 
            content: prompts[fieldType] || prompts.default, 
            flags: 64
        });

        // Set up message collector
        const collector = interaction.channel.createMessageCollector({ 
            filter: m => m.author.id === userId,
            time: 60000,
            max: 1 
        });

        collector.on('collect', async (message) => {
            try {
                // Handle field input based on type
                if (['image', 'thumbnail'].includes(fieldType)) {
                    if (message.attachments.size > 0) {
                        const attachment = message.attachments.first();
                        if (!isValidImageUrl(attachment.url)) {
                            return await interaction.editReply({
                                content: "❌ Invalid image format! Please upload a valid image file (PNG, JPG, JPEG, GIF, WEBP).",
                            });
                        }
                        session[fieldType] = attachment.url;
                    } else {
                        const imageUrl = message.content.trim();
                        if (!isValidImageUrl(imageUrl)) {
                            return await interaction.editReply({
                                content: "❌ Invalid image URL! Please provide a valid image URL or upload an image.",
                            });
                        }
                        session[fieldType] = imageUrl;
                        await message.delete().catch(() => {});
                    }
                }
                else if (fieldType === 'titlelink' || fieldType === 'buttonurl') {
                    const url = message.content.trim();
                    if (!isValidUrl(url)) {
                        return await interaction.editReply({
                            content: "❌ Invalid URL! Please provide a valid URL starting with http:// or https://",
                        });
                    }
                    session[fieldType === 'titlelink' ? 'titleLink' : 'buttonUrl'] = url;
                    await message.delete().catch(() => {});
                }
                else if (fieldType === 'buttonlabel') {
                    session.buttonLabel = message.content.trim();
                    await message.delete().catch(() => {});
                }
                else {
                    session[fieldType] = message.content.trim();
                    await message.delete().catch(() => {});
                }

                // Update session and confirm
                tempEmbedData.set(userId, session);
                await interaction.editReply({
                    content: `✅ ${fieldType.charAt(0).toUpperCase() + fieldType.slice(1)} has been updated!`,
                });

            } catch (error) {
                console.error('Field Input Error:', error);
                await interaction.editReply({
                    content: "❌ An error occurred while processing your input.",
                });
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.editReply({
                    content: "⏱️ Time expired. Please try again.",
                }).catch(console.error);
            }
        });

    } catch (error) {
        console.error('Interaction Error:', error);
        if (!interaction.replied) {
            await interaction.reply({ 
                content: "❌ An error occurred while processing your request.", 
                flags: 64 
            });
        }
    }
});

// Utility function to validate image URLs
function isValidImageUrl(url) {
    try {
        const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        const urlObj = new URL(url);
        return validExtensions.some(ext => urlObj.pathname.toLowerCase().endsWith(ext));
    } catch {
        return false;
    }
}

// Utility function to validate URLs
function isValidUrl(url) {
    try {
        new URL(url);
        return url.startsWith('http://') || url.startsWith('https://');
    } catch {
        return false;
    }
}

// Preview Handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("embed_preview_")) return;

    try {
        const userId = interaction.user.id;
        
        // Check for active session
        if (!tempEmbedData.has(userId)) {
            return interaction.reply({ 
                content: "❌ No active embed session found.", 
                flags: 64 
            });
        }

        const embedData = tempEmbedData.get(userId);

        // Validate required fields
        if (!embedData.title && !embedData.description) {
            return interaction.reply({
                content: "❌ You must set either a title or description for the embed!",
                flags: 64
            });
        }

        // Create embed
        const embed = new EmbedBuilder();

        // Set color
        try {
            embed.setColor(embedData.color || "#00AE86");
        } catch (error) {
            console.error('Color error:', error);
            embed.setColor("#00AE86"); // Fallback color
        }

        // Set title if exists
        if (embedData.title) {
            try {
                embed.setTitle(embedData.title);
                
                // Set URL if exists and title is set
                if (embedData.titleLink && isValidUrl(embedData.titleLink)) {
                    embed.setURL(embedData.titleLink);
                }
            } catch (error) {
                console.error('Title error:', error);
            }
        }

        // Set description if exists
        if (embedData.description) {
            try {
                embed.setDescription(embedData.description);
            } catch (error) {
                console.error('Description error:', error);
            }
        }

        // Set footer if exists
        if (embedData.footer) {
            try {
                embed.setFooter({ text: embedData.footer });
            } catch (error) {
                console.error('Footer error:', error);
            }
        }

        // Set image if exists
        if (embedData.image) {
            try {
                if (isValidImageUrl(embedData.image)) {
                    embed.setImage(embedData.image);
                }
            } catch (error) {
                console.error('Image error:', error);
            }
        }

        // Set thumbnail if exists
        if (embedData.thumbnail) {
            try {
                if (isValidImageUrl(embedData.thumbnail)) {
                    embed.setThumbnail(embedData.thumbnail);
                }
            } catch (error) {
                console.error('Thumbnail error:', error);
            }
        }

        // Add timestamp
        embed.setTimestamp();

        // Create preview message
        const previewMessage = [
            "👀 **Preview of your embed:**",
            "",
            "**Current Settings:**",
            `• Title: ${embedData.title ? '✅' : '❌'}`,
            `• Description: ${embedData.description ? '✅' : '❌'}`,
            `• Color: ${embedData.color ? '✅' : '⚪ (Default)'}`,
            `• Footer: ${embedData.footer ? '✅' : '❌'}`,
            `• Image: ${embedData.image ? '✅' : '❌'}`,
            `• Thumbnail: ${embedData.thumbnail ? '✅' : '❌'}`,
            `• Title Link: ${embedData.titleLink ? '✅' : '❌'}`,
            `• Button: ${embedData.buttonLabel && embedData.buttonUrl ? '✅' : '❌'}`
        ].join('\n');

        // Create buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`embed_send_${userId}`)
                    .setLabel('🚀 Send Embed')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`embed_back_to_editor_${userId}`)
                    .setLabel('✏️ Back to Editor')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`embed_cancel_${userId}`)
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

        // Prepare components array
        const components = [buttons];

        // Add button preview if both label and valid URL exist
        if (embedData.buttonLabel && embedData.buttonUrl && isValidUrl(embedData.buttonUrl)) {
            const previewButton = new ButtonBuilder()
                .setLabel(embedData.buttonLabel)
                .setURL(embedData.buttonUrl)
                .setStyle(ButtonStyle.Link);

            const buttonRow = new ActionRowBuilder()
                .addComponents(previewButton);

            components.unshift(buttonRow); // Add button row before control buttons
        }

        await interaction.reply({
            content: previewMessage,
            embeds: [embed],
            components: components,
            flags: 64
        });

    } catch (error) {
        console.error('Error in preview:', error);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: "❌ An error occurred while generating the preview.", 
                flags: 64 
            });
        } else {
            await interaction.editReply({ 
                content: "❌ An error occurred while generating the preview.", 
                components: [],
                flags: 64 
            });
        }
    }
});

// Send Handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("embed_send_")) return;

    try {
        const userId = interaction.user.id;
        
        // Check for active session
        if (!tempEmbedData.has(userId)) {
            return interaction.reply({ 
                content: "❌ No active embed session found.", 
                flags: 64 
            });
        }

        const embedData = tempEmbedData.get(userId);

        // Validate channel
        if (!embedData.selectedChannel) {
            return interaction.reply({ 
                content: "❌ No channel selected! Please select a channel first.", 
                flags: 64 
            });
        }

        // Fetch and validate channel
        const targetChannel = await interaction.client.channels.fetch(embedData.selectedChannel)
            .catch(() => null);

        if (!targetChannel) {
            return interaction.reply({ 
                content: "❌ Selected channel not found or inaccessible!", 
                flags: 64 
            });
        }

        if (!targetChannel.isTextBased()) {
            return interaction.reply({ 
                content: "❌ Selected channel must be a text channel!", 
                flags: 64 
            });
        }

        // Check bot permissions in target channel
        const permissions = targetChannel.permissionsFor(interaction.client.user);
        if (!permissions.has(['SendMessages', 'ViewChannel', 'EmbedLinks'])) {
            return interaction.reply({ 
                content: "❌ Bot doesn't have required permissions in the selected channel!", 
                flags: 64 
            });
        }

        // Validate required fields
        if (!embedData.title && !embedData.description) {
            return interaction.reply({
                content: "❌ You must set either a title or description for the embed!",
                flags: 64
            });
        }

        // Create embed
        const embed = new EmbedBuilder();

        // Set color
        try {
            embed.setColor(embedData.color || "#00AE86");
        } catch {
            embed.setColor("#00AE86"); // Fallback color
        }

        // Set title and URL
        if (embedData.title) {
            embed.setTitle(embedData.title);
            if (embedData.titleLink && isValidUrl(embedData.titleLink)) {
                embed.setURL(embedData.titleLink);
            }
        }

        // Set description
        if (embedData.description) {
            embed.setDescription(embedData.description);
        }

        // Set footer
        if (embedData.footer) {
            embed.setFooter({ text: embedData.footer });
        }

        // Set image
        if (embedData.image && isValidImageUrl(embedData.image)) {
            embed.setImage(embedData.image);
        }

        // Set thumbnail
        if (embedData.thumbnail && isValidImageUrl(embedData.thumbnail)) {
            embed.setThumbnail(embedData.thumbnail);
        }

        // Add timestamp
        embed.setTimestamp();

        // Prepare message options
        const messageOptions = { embeds: [embed] };

        // Add button if both label and URL are present
        if (embedData.buttonLabel && embedData.buttonUrl && isValidUrl(embedData.buttonUrl)) {
            const button = new ButtonBuilder()
                .setLabel(embedData.buttonLabel)
                .setURL(embedData.buttonUrl)
                .setStyle(ButtonStyle.Link);

            const buttonRow = new ActionRowBuilder()
                .addComponents(button);

            messageOptions.components = [buttonRow];
        }

        // Confirmation buttons
        const confirmButtons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`embed_confirm_send_${userId}`)
                    .setLabel('✅ Yes, send it!')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`embed_cancel_send_${userId}`)
                    .setLabel('❌ No, cancel')
                    .setStyle(ButtonStyle.Danger)
            );

        // Show confirmation dialog
        await interaction.reply({
            content: `📢 **Are you sure you want to send this embed to <#${targetChannel.id}>?**\n\n**Preview:**`,
            embeds: [embed],
            components: [confirmButtons],
            flags: 64
        });

        // Create confirmation collector
        const filter = i => i.user.id === userId && 
            (i.customId === `embed_confirm_send_${userId}` || i.customId === `embed_cancel_send_${userId}`);
        
        const collector = interaction.channel.createMessageComponentCollector({
            filter,
            time: 30000,
            max: 1
        });

        collector.on('collect', async (i) => {
            if (i.customId === `embed_confirm_send_${userId}`) {
                try {
                    // Send embed with prepared options
                    await targetChannel.send(messageOptions);
                    
                    // Clear session
                    tempEmbedData.delete(userId);

                    // Update response
                    await i.update({
                        content: `✅ Embed successfully sent to <#${targetChannel.id}>!`,
                        embeds: [],
                        components: [],
                        flags: 64
                    });
                } catch (error) {
                    console.error('Error sending embed:', error);
                    await i.update({
                        content: "❌ Failed to send embed. Please try again.",
                        embeds: [],
                        components: [],
                        flags: 64
                    });
                }
            } else {
                // Handle cancellation
                await i.update({
                    content: "❌ Embed send cancelled.",
                    embeds: [],
                    components: [],
                    flags: 64
                });
            }
        });

        collector.on('end', async (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                await interaction.editReply({
                    content: "⏱️ Confirmation timed out. Please try again.",
                    embeds: [],
                    components: [],
                    flags: 64
                });
            }
        });

    } catch (error) {
        console.error('Error in send:', error);
        if (!interaction.replied) {
            await interaction.reply({ 
                content: "❌ An error occurred while processing your request.", 
                flags: 64 
            });
        }
    }
});

// Purge
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand()) return;
  
    if (interaction.commandName === "purge") {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.reply({ 
                content: "❌ You need `Manage Messages` permission!", 
                flags: 64 
            });
        }
  
        const user = interaction.options.getUser("user");
        const specificChannel = interaction.options.getChannel("channel");
        
        if (!user) return interaction.reply({ 
            content: "❌ You must mention a user!", 
            flags: 64 
        });

        await interaction.deferReply({ flags: 64 });
        
        let stats = {
            totalDeleted: 0,
            recentDeleted: 0,
            oldDeleted: 0,
            errors: 0,
            processedChannels: 0
        };
        let oldMessages = [];
        let logData = [];
        let lastProgressUpdate = Date.now();
        const progressUpdateInterval = 5000; // 5 seconds

        async function updateProgress(interaction, stats, isInitial = false) {
            if (Date.now() - lastProgressUpdate < progressUpdateInterval && !isInitial) return;
            
            const content = [
                `🔍 Scanning messages...`,
                `📊 Current Progress:`,
                `✨ Recent messages deleted: **${stats.recentDeleted}**`,
                `📚 Older messages found: **${oldMessages.length}**`,
                `🔄 Channels processed: **${stats.processedChannels}**`,
                `⚠️ Errors encountered: **${stats.errors}**`
            ].join('\n');

            try {
                await interaction.editReply({ content, flags: 64 });
                lastProgressUpdate = Date.now();
            } catch (error) {
                console.error('Failed to update progress:', error);
            }
        }

        async function processChannel(channel) {
            if (!channel.isTextBased()) return;

            try {
                let lastId = null;
                let messageCount = 0;
                const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
                
                while (true) {
                    const messages = await channel.messages.fetch({ 
                        limit: 100, 
                        before: lastId 
                    });
                    
                    if (messages.size === 0) break;
                    lastId = messages.last().id;
                    messageCount += messages.size;

                    const userMessages = messages.filter(m => m.author.id === user.id);
                    
                    if (userMessages.size > 0) {
                        const recentMessages = userMessages.filter(m => m.createdTimestamp > twoWeeksAgo);
                        const olderMessages = userMessages.filter(m => m.createdTimestamp <= twoWeeksAgo);

                        // Log messages
                        userMessages.forEach(m => {
                            logData.push(`[${new Date(m.createdTimestamp).toISOString()}] [#${channel.name}] ${m.author.tag}: ${m.content || "(Embed/Attachment)"}\n`);
                        });

                        // Handle recent messages
                        if (recentMessages.size > 0) {
                            try {
                                await channel.bulkDelete(recentMessages, true);
                                stats.recentDeleted += recentMessages.size;
                                stats.totalDeleted += recentMessages.size;
                                await updateProgress(interaction, stats);
                            } catch (error) {
                                console.error(`Bulk delete error in ${channel.name}:`, error);
                                stats.errors++;
                            }
                        }

                        // Queue older messages
                        if (olderMessages.size > 0) {
                            oldMessages.push(...olderMessages.map(m => ({
                                id: m.id,
                                channelId: channel.id,
                                content: m.content || "(Embed/Attachment)"
                            })));
                        }
                    }

                    if (messageCount >= 10000 || (messageCount >= 1000 && userMessages.size === 0)) {
                        break;
                    }
                }

                stats.processedChannels++;
                await updateProgress(interaction, stats);

            } catch (error) {
                console.error(`Error in ${channel.name}:`, error);
                stats.errors++;
                await interaction.followUp({
                    content: `⚠️ Error in #${channel.name}: ${error.message}`,
                    flags: 64
                });
            }
        }

        try {
            // Initial progress message
            await updateProgress(interaction, stats, true);

            // Process channels
            if (specificChannel) {
                await processChannel(specificChannel);
            } else {
                const textChannels = interaction.guild.channels.cache.filter(c => c.isTextBased());
                for (const channel of textChannels.values()) {
                    await processChannel(channel);
                }
            }

            // Handle older messages
            if (oldMessages.length > 0) {
                await interaction.followUp({
                    content: `⏳ Processing ${oldMessages.length} older messages...`,
                    flags: 64
                });
                const oldMessageStats = await deleteOldMessagesWithRateLimit(interaction, oldMessages, user.tag);
                stats.oldDeleted = oldMessageStats.deleted;
                stats.totalDeleted += oldMessageStats.deleted;
                stats.errors += oldMessageStats.errors;
            }

            // Save logs
            if (logData.length > 0) {
                await saveLogToFile(user.id, user.tag, logData, interaction);
            }

            // Final report
            const channelInfo = specificChannel ? ` in #${specificChannel.name}` : " across all channels";
            const finalReport = [
                `✅ Purge Complete!`,
                ``,
                `📊 Final Statistics:`,
                `✨ Recent messages deleted: **${stats.recentDeleted}**`,
                `📚 Older messages deleted: **${stats.oldDeleted}**`,
                `📝 Total messages deleted: **${stats.totalDeleted}**`,
                `🔄 Channels processed: **${stats.processedChannels}**`,
                `⚠️ Errors encountered: **${stats.errors}**`,
                ``,
                `🎯 Target: ${user.tag}${channelInfo}`
            ].join('\n');

            await interaction.editReply({
                content: finalReport,
                flags: 64
            });

        } catch (error) {
            console.error('Purge command error:', error);
            await interaction.editReply({
                content: '❌ An error occurred while processing the purge command.',
                flags: 64
            });
        }
    }
});

// Function to save log to file
async function saveLogToFile(userId, userTag, logData, interaction) {
    try {
        // Create logs directory if it doesn't exist
        const logDir = path.join(__dirname, "logs");
        await fs.promises.mkdir(logDir, { recursive: true });

        // Clean up filenames and create paths
        const cleanUsername = userTag.replace(/[^a-z0-9]/gi, '_').slice(0, 32);
        const serverName = interaction.guild.name.replace(/[^a-z0-9]/gi, '_').slice(0, 32);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${serverName}_${cleanUsername}_${timestamp}.txt`;
        const filePath = path.join(logDir, fileName);

        // Create detailed log header
        const logHeader = [
            `=== Message Purge Log ===`,
            ``,
            `Server Information:`,
            `  Name: ${interaction.guild.name}`,
            `  ID: ${interaction.guild.id}`,
            ``,
            `Target User Information:`,
            `  Username: ${userTag}`,
            `  ID: ${userId}`,
            ``,
            `Purge Information:`,
            `  Executed by: ${interaction.user.tag} (${interaction.user.id})`,
            `  Date: ${new Date().toLocaleString()}`,
            `  Total Messages: ${logData.length}`,
            ``,
            `=== Messages ===`,
            ``
        ].join('\n');

        // Format log content with message count
        const formattedLogData = logData.map((entry, index) => 
            `[${index + 1}] ${entry}`
        ).join('');

        const logContent = logHeader + formattedLogData;

        // Write file with error handling
        await fs.promises.writeFile(filePath, logContent, 'utf8');
        console.log(`📂 Log file created: ${filePath}`);

        // Fetch log channel from database with error handling
        const logChannelData = db.prepare('SELECT log_channel FROM guild_settings WHERE guild_id = ?')
            .get(interaction.guild.id);

        if (logChannelData?.log_channel) {
            try {
                const logChannel = await interaction.guild.channels.fetch(logChannelData.log_channel);
                
                if (logChannel?.isTextBased()) {
                    // Create detailed embed
                    const logEmbed = new EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('Message Purge Log')
                        .setDescription([
                            `📝 Messages have been purged from ${userTag}`,
                            ``,
                            `📊 **Statistics**`,
                            `• Total Messages: ${logData.length}`,
                            `• File Name: \`${fileName}\``
                        ].join('\n'))
                        .addFields(
                            { 
                                name: '👮 Moderator', 
                                value: `${interaction.user.tag}\n(${interaction.user.id})`, 
                                inline: true 
                            },
                            { 
                                name: '🎯 Target User', 
                                value: `${userTag}\n(${userId})`, 
                                inline: true 
                            },
                            { 
                                name: '⏰ Timestamp', 
                                value: `<t:${Math.floor(Date.now() / 1000)}:F>`, 
                                inline: true 
                            }
                        )
                        .setTimestamp()
                        .setFooter({ 
                            text: `Server: ${interaction.guild.name} | ID: ${interaction.guild.id}` 
                        });

                    // Send embed with file
                    await logChannel.send({
                        embeds: [logEmbed],
                        files: [{
                            attachment: filePath,
                            name: fileName,
                            description: `Purge log for ${userTag}`
                        }]
                    });

                    console.log(`📨 Log file sent to channel: #${logChannel.name}`);
                }
            } catch (channelError) {
                console.error('Error accessing log channel:', channelError);
                await interaction.followUp({
                    content: "⚠️ Could not send log to the designated log channel. Please check channel permissions.",
                    flags: 64
                });
            }
        }

        // Confirm to user
        await interaction.followUp({
            content: [
                `✅ Log file has been saved successfully!`,
                `📁 File: \`${fileName}\``,
                `📊 Total messages logged: **${logData.length}**`
            ].join('\n'),
            flags: 64
        });

        // Cleanup old log files (older than 30 days)
        try {
            const files = await fs.promises.readdir(logDir);
            const now = Date.now();
            const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days

            for (const file of files) {
                const filePath = path.join(logDir, file);
                const stats = await fs.promises.stat(filePath);
                if (now - stats.mtime.getTime() > maxAge) {
                    await fs.promises.unlink(filePath);
                    console.log(`🗑️ Deleted old log file: ${file}`);
                }
            }
        } catch (cleanupError) {
            console.error('Error during log cleanup:', cleanupError);
        }

    } catch (error) {
        console.error("Error in log handling:", error);
        await interaction.followUp({
            content: [
                "❌ An error occurred while saving the log file:",
                `\`\`\`${error.message}\`\`\``,
                "Please contact an administrator."
            ].join('\n'),
            flags: 64
        });
    }
}

// Function to delete old messages with rate limit
async function deleteOldMessagesWithRateLimit(interaction, messageData, userTag) {
    let delay = 1500;
    let deletedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let lastProgressUpdate = Date.now();
    const progressUpdateInterval = 5000; // Update progress every 5 seconds

    // Create initial progress message
    const progressMessage = await interaction.followUp({
        content: `⏳ Starting deletion of ${messageData.length} older messages...`,
        flags: 64
    });

    for (const messageInfo of messageData) {
        try {
            // Fetch channel
            const channel = await interaction.guild.channels.fetch(messageInfo.channelId).catch(() => null);
            if (!channel) {
                skippedCount++;
                console.warn(`Channel ${messageInfo.channelId} not found or inaccessible`);
                continue;
            }

            // Fetch and delete message
            const message = await channel.messages.fetch(messageInfo.id).catch(() => null);
            if (!message) {
                skippedCount++;
                continue;
            }

            await message.delete();
            deletedCount++;

            // Update progress periodically
            if (Date.now() - lastProgressUpdate >= progressUpdateInterval) {
                const progress = Math.floor((deletedCount + errorCount + skippedCount) / messageData.length * 100);
                await progressMessage.edit({
                    content: [
                        `⏳ Deletion in progress... (${progress}%)`,
                        `✅ Deleted: **${deletedCount}**`,
                        `⚠️ Errors: **${errorCount}**`,
                        `⏭️ Skipped: **${skippedCount}**`,
                        `🎯 Total: **${messageData.length}**`,
                        `⏱️ Current delay: ${delay}ms`
                    ].join('\n'),
                    flags: 64
                }).catch(() => null);
                lastProgressUpdate = Date.now();
            }

            // Dynamic delay adjustment
            await new Promise(r => setTimeout(r, delay));

        } catch (error) {
            errorCount++;
            
            if (error.code === 50013) {
                console.error(`❌ Missing permissions in channel ${messageInfo.channelId}`);
                // Skip remaining messages in this channel
                messageData = messageData.filter(m => m.channelId !== messageInfo.channelId);
                
            } else if (error.code === 429) {
                console.warn(`🚦 Rate limited! Increasing delay from ${delay}ms to ${delay * 2}ms`);
                delay = Math.min(delay * 2, 5000); // Cap at 5 seconds
                await new Promise(r => setTimeout(r, delay * 2));
                
            } else if (error.code === 10008) {
                // Message already deleted
                skippedCount++;
                
            } else {
                console.error(`❌ Error deleting message ${messageInfo.id}:`, error);
                // Slightly increase delay on unknown errors
                delay = Math.min(delay + 100, 5000);
            }
        }
    }

    // Send final report
    const finalReport = [
        `✅ Deletion Complete!`,
        ``,
        `📊 Final Statistics:`,
        `✨ Successfully deleted: **${deletedCount}**`,
        `⚠️ Errors encountered: **${errorCount}**`,
        `⏭️ Messages skipped: **${skippedCount}**`,
        `📝 Total processed: **${messageData.length}**`
    ].join('\n');

    try {
        await progressMessage.edit({
            content: finalReport,
            flags: 64
        });
    } catch {
        // If editing fails, send as new message
        await interaction.followUp({
            content: finalReport,
            flags: 64
        });
    }

    // Log completion to console
    console.log(`Completed message deletion for ${userTag}:`, {
        deleted: deletedCount,
        errors: errorCount,
        skipped: skippedCount,
        total: messageData.length
    });

    return {
        deletedCount,
        errorCount,
        skippedCount
    };
}

// Kick Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-kick') return;

    const guildId = interaction.guild?.id;

    // Ensure the command is being used in a guild
    if (!guildId) {
        return interaction.reply({
            content: 'This command can only be used in a server.',
            flags: 64
        });
    }

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    ensureGuildSettings(guildId);

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!target) {
        return interaction.reply({
            content: 'You must specify a user to kick.',
            flags: 64
        });
    }

    try {
        // Apply the kick to all accessible guilds
        let successfulKicks = 0;
        let failedKicks = 0;

        for (const guild of client.guilds.cache.values()) {
            const member = guild.members.cache.get(target.id);
            if (member) {
                try {
                    await member.kick(reason);
                    successfulKicks++;
                } catch (err) {
                    console.error(`Failed to kick ${target.tag} in guild ${guild.name}:`, err);
                    failedKicks++;
                }
            }
        }

        if (successfulKicks > 0) {
            return interaction.reply({
                content: `${target.tag} has been kicked from ${successfulKicks} server(s).${failedKicks > 0 ? ` Failed to kick from ${failedKicks} server(s).` : ''}`,
                flags: 64
            });
        } else {
            return interaction.reply({
                content: `${target.tag} was not found in any of the servers this bot has access to.`,
                flags: 64
            });
        }
    } catch (error) {
        console.error('Error kicking user:', error);
        return interaction.reply({
            content: 'There was an error trying to kick the user. Please try again later.',
            flags: 64
        });
    }
});

// Ban Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand() || interaction.commandName !== "tgc-ban") return;

    // Check Permissions
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const target = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason") || "No reason provided";
    const days = interaction.options.getInteger("days") || 0;
    const hours = interaction.options.getInteger("hours") || 0;
    const minutes = interaction.options.getInteger("minutes") || 0;
    const deleteMessageDays = interaction.options.getInteger("delete_messages") || 0;

    // Validate inputs
    if (!target) {
        return interaction.reply({ content: "❌ You must specify a user to ban.", flags: 64 });
    }
    if (deleteMessageDays < 0 || deleteMessageDays > 14) {
        return interaction.reply({ content: "❌ Message deletion must be between 0 and 14 days.", flags: 64 });
    }

    try {
        // Calculate total ban duration in milliseconds
        const totalDuration = (days * 24 * 60 * 60 * 1000) + 
                              (hours * 60 * 60 * 1000) + 
                              (minutes * 60 * 1000);
        const expiresAt = totalDuration > 0 ? Date.now() + totalDuration : null;

        // Convert duration to human-readable text
        let durationText = "";
        if (days > 0) durationText += `${days} days `;
        if (hours > 0) durationText += `${hours} hours `;
        if (minutes > 0) durationText += `${minutes} minutes`;
        if (!durationText) durationText = "Permanent";

        // Get list of servers where the bot **can** ban
        const serverList = client.guilds.cache
            .filter(guild => guild.members.me.permissions.has("BanMembers"))
            .map(guild => `• ${guild.name}`);

        if (serverList.length === 0) {
            return interaction.reply({ content: "❌ The bot does not have ban permissions in any server.", flags: 64 });
        }

        //  Notify the user before banning
        const banNotificationEmbed = new EmbedBuilder()
            .setColor("#FF0000")
            .setTitle("🔨 You Have Been Banned")
            .setDescription([
                `You have been globally banned from all servers using **The Great Clock.**`,
                ``,
                `**Reason:** ${reason}`,
                `**Duration:** ${durationText}`,
                ``,
                `**Affected Servers:**`,
                serverList.join("\n"),
                ``,
                `If this was a mistake, please contact the server admins.`
            ].join("\n"))
            .setTimestamp();

        try {
            await target.send({ embeds: [banNotificationEmbed] });
        } catch (error) {
            console.log(`⚠️ Could not send ban notification to ${target.tag}.`);
        }

        // 🛠️ Store the ban in the database
        try {
            db.prepare(`
                INSERT INTO global_bans (user_id, reason, expires_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE 
                SET reason = excluded.reason, expires_at = excluded.expires_at
            `).run(target.id, reason, expiresAt);
        } catch (error) {
            console.error("Database error:", error);
            return interaction.reply({ content: "❌ Database error while storing the ban.", flags: 64 });
        }

        // 🔨 Apply the ban across all guilds
        let successCount = 0;
        let failCount = 0;
        let successfulBans = [];
        let failedBans = [];

        for (const guild of client.guilds.cache.values()) {
            try {
                const botMember = guild.members.me;
                if (!botMember || !botMember.permissions.has("BanMembers")) {
                    failedBans.push(guild.name);
                    failCount++;
                    continue;
                }

                await guild.members.ban(target.id, {
                    reason: reason,
                    deleteMessageSeconds: deleteMessageDays * 86400 // Convert days to seconds
                });

                successCount++;
                successfulBans.push(guild.name);
            } catch (err) {
                console.error(`❌ Failed to ban in ${guild.name}:`, err);
                failCount++;
                failedBans.push(guild.name);
            }
        }

        // Create and send the ban confirmation embed
        const embed = new EmbedBuilder()
            .setColor("#FF0000")
            .setTitle("🔨 Global Ban Executed")
            .setDescription([
                `**Target:** ${target.tag} (${target.id})`,
                `**Reason:** ${reason}`,
                `**Duration:** ${durationText}`,
                deleteMessageDays > 0 ? `**Message Deletion:** Last ${deleteMessageDays} days` : "",
                "",
                "**Results:**",
                `✅ Successfully banned in **${successCount}** servers:`,
                successfulBans.length ? successfulBans.map(name => `• ${name}`).join("\n") : "*None*",
                failCount > 0 ? [
                    `\n❌ Failed to ban in **${failCount}** servers:`,
                    failedBans.length ? failedBans.map(name => `• ${name}`).join("\n") : "*None*"
                ].join("\n") : ""
            ].join("\n"))
            .setTimestamp();

        await interaction.reply({ embeds: [embed]});

    } catch (error) {
        console.error("❌ Error executing global ban:", error);
        await interaction.reply({ content: "An error occurred while executing the ban.", flags: 64 });
    }
});

// Ban List Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-banlist') return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    // Defer the reply immediately
    await interaction.deferReply({ flags: 64 });

    try {
        // Synchronize bans before displaying them
        await synchronizeBans();

        // Fetch bans from the database
        const bans = db.prepare('SELECT * FROM global_bans').all();

        if (!bans.length) {
            return interaction.editReply({
                content: 'No users are currently banned.'
            });
        }

        // Fetch user details and build the list
        const banList = await Promise.all(
            bans.map(async (ban) => {
                try {
                    const user = await client.users.fetch(ban.user_id);
                    const expiresText = ban.expires_at
                        ? `Expires: <t:${Math.floor(ban.expires_at / 1000)}:R>` // Discord Relative Timestamp
                        : 'Permanent Ban';

                    return `**${user.tag}** (ID: ${ban.user_id})\n**Reason:** ${ban.reason}\n${expiresText}`;
                } catch {
                    return `**Unknown User** (ID: ${ban.user_id})\n**Reason:** ${ban.reason}\n${
                        ban.expires_at ? `Expires: <t:${Math.floor(ban.expires_at / 1000)}:R>` : 'Permanent Ban'
                    }`;
                }
            })
        );

        // Split message if over 2000 characters
        const MAX_MESSAGE_LENGTH = 2000;
        const banChunks = [];
        let currentChunk = '';

        for (const entry of banList) {
            if (currentChunk.length + entry.length + 2 > MAX_MESSAGE_LENGTH) {
                banChunks.push(currentChunk);
                currentChunk = '';
            }
            currentChunk += entry + '\n\n';
        }
        if (currentChunk) banChunks.push(currentChunk);

        // Send the first chunk as the main reply
        await interaction.editReply({ content: banChunks[0] });

        // Send remaining chunks as follow-up messages
        for (let i = 1; i < banChunks.length; i++) {
            await interaction.followUp({ 
                content: banChunks[i],
                flags: 64
            });
        }

    } catch (error) {
        console.error('Error fetching ban list:', error);
        await interaction.editReply({
            content: 'An error occurred while fetching the ban list.'
        });
    }
});

// unban utocomplete handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;

    if (interaction.commandName === 'tgc-unban') {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        try {
            // Get all banned users from database and guilds
            const bannedUsers = new Map();

            // Get database bans
            const dbBans = db.prepare('SELECT * FROM global_bans').all();
            for (const ban of dbBans) {
                bannedUsers.set(ban.user_id, {
                    id: ban.user_id,
                    reason: ban.reason,
                    source: 'Database'
                });
            }

            // Get guild bans
            for (const guild of client.guilds.cache.values()) {
                try {
                    const guildBans = await guild.bans.fetch();
                    for (const [userId, banInfo] of guildBans) {
                        if (!bannedUsers.has(userId)) {
                            bannedUsers.set(userId, {
                                id: userId,
                                reason: banInfo.reason || 'No reason provided',
                                source: guild.name
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Failed to fetch bans from guild ${guild.name}:`, error);
                }
            }

            // Try to fetch user details for each banned user
            const bannedUserDetails = await Promise.all(
                Array.from(bannedUsers.entries()).map(async ([userId, banInfo]) => {
                    try {
                        const user = await client.users.fetch(userId);
                        return {
                            id: userId,
                            name: user.tag,
                            reason: banInfo.reason,
                            source: banInfo.source
                        };
                    } catch {
                        return {
                            id: userId,
                            name: 'Unknown User',
                            reason: banInfo.reason,
                            source: banInfo.source
                        };
                    }
                })
            );

            // Filter based on search input
            const matches = bannedUserDetails.filter(user => 
                user.name.toLowerCase().includes(focusedValue) || 
                user.id.includes(focusedValue)
            );

            // Format choices
            const choices = matches.slice(0, 25).map(user => ({
                name: `${user.name} (${user.source})`,
                value: user.id
            }));

            await interaction.respond(choices);

        } catch (error) {
            console.error('Error in unban autocomplete:', error);
            await interaction.respond([]);
        }
    }
});

// Unban Command Handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-unban') return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: '❌ You do not have permission to use this command.',
            flags: 64
        });
    }

    await interaction.deferReply({ });

    try {
        const searchInput = interaction.options.getString('search');
        
        // Get all banned users from database and guilds
        const bannedUsers = new Map();

        // Get database bans
        const dbBans = db.prepare('SELECT * FROM global_bans').all();
        for (const ban of dbBans) {
            bannedUsers.set(ban.user_id, {
                id: ban.user_id,
                reason: ban.reason,
                source: 'Database Ban',
                expires: ban.expires_at ? new Date(ban.expires_at).toLocaleString() : 'Never'
            });
        }

        // Get guild bans
        for (const guild of client.guilds.cache.values()) {
            try {
                const guildBans = await guild.bans.fetch();
                for (const [userId, banInfo] of guildBans) {
                    if (!bannedUsers.has(userId)) {
                        bannedUsers.set(userId, {
                            id: userId,
                            reason: banInfo.reason || 'No reason provided',
                            source: `Server: ${guild.name}`,
                            expires: 'N/A'
                        });
                    }
                }
            } catch (error) {
                console.error(`Failed to fetch bans from guild ${guild.name}:`, error);
            }
        }

        // Try to find the user by ID or username
        let targetUserId = null;
        let userDetails = null;
        
        // First, check if the search input is a valid user ID
        if (/^\d+$/.test(searchInput)) {
            targetUserId = searchInput;
            try {
                userDetails = await client.users.fetch(targetUserId);
            } catch {
                // User not found by ID
            }
        }

        // If not found by ID, try to find by username
        if (!userDetails) {
            for (const [userId, banInfo] of bannedUsers) {
                try {
                    const user = await client.users.fetch(userId);
                    if (user.tag.toLowerCase().includes(searchInput.toLowerCase())) {
                        targetUserId = userId;
                        userDetails = user;
                        break;
                    }
                } catch {
                    continue;
                }
            }
        }

        if (!targetUserId || !bannedUsers.has(targetUserId)) {
            return interaction.editReply({
                content: '❌ Could not find a banned user matching your search.',
                flags: 64
            });
        }

        const banInfo = bannedUsers.get(targetUserId);

        // Create confirmation embed
        const confirmEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🔓 Confirm Unban')
            .setDescription([
                `Are you sure you want to unban this user?`,
                '',
                `👤 **User:** ${userDetails ? userDetails.tag : `ID: ${targetUserId}`}`,
                `📋 **Ban Source:** ${banInfo.source}`,
                `❓ **Reason:** ${banInfo.reason}`,
                `⏰ **Expires:** ${banInfo.expires}`,
                '',
                '✅ Click the buttons below to confirm or cancel.'
            ].join('\n'))
            .setThumbnail(userDetails ? userDetails.displayAvatarURL({ dynamic: true }) : null)
            .setTimestamp();

        // Create confirmation buttons
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_unban_${targetUserId}`)
                    .setLabel('✅ Confirm Unban')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`cancel_unban_${targetUserId}`)
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

        // Send confirmation message
        const confirmMsg = await interaction.editReply({
            embeds: [confirmEmbed],
            components: [row]
        });

        // Create button collector
        const collector = confirmMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 30000,
            max: 1
        });

        collector.on('collect', async i => {
            if (i.customId === `confirm_unban_${targetUserId}`) {
                await processUnban(i, targetUserId, userDetails);
            } else {
                await i.update({
                    content: '❌ Unban cancelled.',
                    embeds: [],
                    components: [],
                    flags: 64
                });
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.editReply({
                    content: '⏰ Unban confirmation timed out.',
                    embeds: [],
                    components: [],
                    flags: 64
                });
            }
        });

    } catch (error) {
        console.error('Error in unban command:', error);
        return interaction.editReply({
            content: '❌ An error occurred while processing the unban command.',
            flags: 64
        });
    }
});

// Process Unban Function
async function processUnban(interaction, targetUserId, userDetails) {
    try {
        // Remove from database if exists
        db.prepare('DELETE FROM global_bans WHERE user_id = ?').run(targetUserId);

        // Unban from all guilds
        const results = [];
        for (const guild of interaction.client.guilds.cache.values()) {
            try {
                const guildBan = await guild.bans.fetch(targetUserId).catch(() => null);
                if (guildBan) {
                    try {
                        await guild.bans.remove(targetUserId);
                        results.push(`✅ Unbanned from **${guild.name}**`);
                    } catch (unbanError) {
                        console.error(`Failed to unban in guild ${guild.name}:`, unbanError);
                        results.push(`❌ Failed to unban in **${guild.name}**`);
                    }
                } else {
                    results.push(`⏭️ Not banned in **${guild.name}**`);
                }
            } catch (error) {
                console.error(`Failed to check/unban in guild ${guild.name}:`, error);
                results.push(`❌ Failed to process in **${guild.name}**`);
            }
        }

        // Create result embed
        const resultEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🔓 Unban Successful')
            .setDescription([
                `Successfully processed unban for **${userDetails ? userDetails.tag : `ID: ${targetUserId}`}**`,
                '',
                '📋 **Results:**',
                results.join('\n')
            ].join('\n'))
            .setTimestamp();

        await interaction.update({
            embeds: [resultEmbed],
            components: [],
            flags: 64
        });

    } catch (error) {
        console.error('Error processing unban:', error);
        await interaction.update({
            content: '❌ An error occurred while processing the unban.',
            embeds: [],
            components: [],
            flags: 64
        });
    }
}

// Synchronize bans between Discord and the database
async function synchronizeBans() {
    try {
        console.log("Synchronizing bans...");

        // Fetch all current bans from the database
        const dbBans = db.prepare('SELECT * FROM global_bans').all();
        const dbBansMap = new Map(dbBans.map(ban => [ban.user_id, ban]));

        // Track users banned in guilds to prevent duplicate operations
        const guildBansMap = new Map();

        // Iterate over all guilds and fetch bans
        for (const [guildId, guild] of client.guilds.cache) {
            try {
                const bans = await guild.bans.fetch();

                for (const [userId, banInfo] of bans) {
                    // Add to guild bans map for tracking
                    guildBansMap.set(userId, banInfo);

                    // If the ban doesn't exist in the database, add it
                    if (!dbBansMap.has(userId)) {
                        const reason = banInfo.reason || 'No reason provided';
                        db.prepare(`
                            INSERT INTO global_bans (user_id, reason, expires_at)
                            VALUES (?, ?, NULL)
                        `).run(userId, reason);
                    }
                }
            } catch (error) {
                console.error(`Failed to fetch bans for guild ${guild.name}:`, error);
            }
        }

        // Reapply any bans missing from guilds
        for (const dbBan of dbBans) {
            if (!guildBansMap.has(dbBan.user_id)) {
                console.log(`Reapplying ban for user ${dbBan.user_id} (${dbBan.reason}) across guilds...`);

                for (const [guildId, guild] of client.guilds.cache) {
                    try {
                        await guild.members.ban(dbBan.user_id, { reason: dbBan.reason });
                        console.log(`Applied ban for user ${dbBan.user_id} in guild ${guild.name}`);
                    } catch (error) {
                        console.error(`Failed to apply ban in guild ${guild.name}:`, error);
                    }
                }
            }
        }

        console.log("Ban synchronization complete.");
    } catch (error) {
        console.error("Error during ban synchronization:", error);
    }
}

// Function to parse duration string (e.g., "1d 2h 30m")
function parseDuration(durationStr) {
    if (durationStr === "0") return 0; // Unmute command

    const regex = /(\d+)(d|h|m)/g;
    let totalMs = 0;
    let match;

    while ((match = regex.exec(durationStr)) !== null) {
        const value = parseInt(match[1]);
        const unit = match[2];

        if (unit === "d") totalMs += value * 24 * 60 * 60 * 1000; // Days → ms
        if (unit === "h") totalMs += value * 60 * 60 * 1000;      // Hours → ms
        if (unit === "m") totalMs += value * 60 * 1000;           // Minutes → ms
    }

    return totalMs > 0 ? totalMs : null;
}

// timeout slash command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-timeout") {
        const user = interaction.options.getUser("user");
        const durationStr = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason") || "No reason provided.";

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }
        
        // Convert duration
        const durationMs = parseDuration(durationStr);
        const expiresAt = durationMs ? Date.now() + durationMs : null;

        // Store timeout in DB
        if (durationMs) {
            db.prepare(`
                INSERT INTO global_timeouts (user_id, expires_at, reason)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET expires_at = ?, reason = ?
            `).run(user.id, expiresAt, reason, expiresAt, reason);
        } else {
            db.prepare("DELETE FROM global_timeouts WHERE user_id = ?").run(user.id);
        }

        // Apply timeout in all servers
        let successGuilds = 0;
        let failedGuilds = 0;
        
        for (const guild of client.guilds.cache.values()) {
            try {
                const member = await guild.members.fetch(user.id);
                if (member) {
                    await member.timeout(durationMs || null, reason);
                    successGuilds++;
                }
            } catch (error) {
                failedGuilds++;
                console.error(`❌ Failed to timeout user in ${guild.name}:`, error);
            }
        }

        interaction.reply({
            content: `✅ **${user.tag}** has been ${durationMs ? `timed out for **${durationStr}**` : "unmuted"} across all servers.\n\n🟢 Success: **${successGuilds}**\n🔴 Failed: **${failedGuilds}**`,
            flags: 64,
        });

        console.log(`🔇 User ${user.tag} has been ${durationMs ? `timed out for ${durationStr}` : "unmuted"} globally.`);
    }
});

// Global Timeout Check
setInterval(async () => {
    const expiredTimeouts = db.prepare("SELECT user_id FROM global_timeouts WHERE expires_at <= ?").all(Date.now());

    for (const { user_id } of expiredTimeouts) {
        for (const guild of client.guilds.cache.values()) {
            try {
                const member = await guild.members.fetch(user_id);
                if (member) {
                    await member.timeout(null);
                }
            } catch (error) {
                console.error(`❌ Failed to remove timeout for user ${user_id} in ${guild.name}:`, error);
            }
        }

        db.prepare("DELETE FROM global_timeouts WHERE user_id = ?").run(user_id);
        console.log(`⏳ Timeout removed for user ${user_id} globally.`);
    }
}, 60000); // Check every minute

// manage command roles handler
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guild } = interaction;

    if (commandName === "tgc-managecommandroles") {
        // Check if the user has administrative permissions
        if (!interaction.member.permissions.has("Administrator")) {
            return interaction.reply({
                content: "You do not have permission to use this command. Only administrators can manage command roles.",
                flags: 64
            });
        }

        const action = options.getString("action");
        const role = options.getRole("role");

        if (!role) {
            return interaction.reply({
                content: "You must specify a valid role.",
                flags: 64
            });
        }

        const guildId = guild.id;

        try {
            if (action === "add") {
                // Add role to the command_roles table
                db.prepare(`
                    INSERT OR IGNORE INTO command_roles (guild_id, role_id)
                    VALUES (?, ?)
                `).run(guildId, role.id);

                await interaction.reply({
                    content: `Role **${role.name}** has been added to the command roles list.`,
                    flags: 64
                });
            } else if (action === "remove") {
                // Remove role from the command_roles table
                const result = db.prepare(`
                    DELETE FROM command_roles 
                    WHERE guild_id = ? AND role_id = ?
                `).run(guildId, role.id);

                if (result.changes === 0) {
                    return interaction.reply({
                        content: `Role **${role.name}** was not found in the command roles list.`,
                        flags: 64
                    });
                }

                await interaction.reply({
                    content: `Role **${role.name}** has been removed from the command roles list.`,
                    flags: 64
                });
            }
        } catch (error) {
            console.error("Error managing command roles:", error);
            await interaction.reply({
                content: "An error occurred while managing command roles.",
                flags: 64
            });
        }
    }
});

// Set Log Channel Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-setlogchannel') return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const guildId = interaction.guild?.id;
    const channel = interaction.options.getChannel('channel'); // Ensure this is set as an option in the command registration

    if (!guildId) {
        return interaction.reply({
            content: 'This command can only be used in a server.',
            flags: 64,
        });
    }

    if (!channel || !channel.isTextBased()) {
        return interaction.reply({
            content: 'Please select a valid text channel.',
            flags: 64,
        });
    }

    try {
        // Store the log channel in the database
        db.prepare(`
            INSERT INTO guild_settings (guild_id, log_channel)
            VALUES (?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET log_channel = excluded.log_channel
        `).run(guildId, channel.id);

        await interaction.reply({
            content: `✅ Log channel has been set to **${channel.name}**.`,
        });

    } catch (error) {
        console.error('Error setting log channel:', error);
        return interaction.reply({
            content: 'An error occurred while setting the log channel. Please try again later.',
            flags: 64,
        });
    }
});

// Set Alert Channel Command
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-setalertchannel') return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild?.id;

    if (!channel.isTextBased()) {
        return interaction.reply({
            content: '❌ Please select a text channel!',
            flags: 64
        });
    }

    try {
        db.prepare(`
            INSERT INTO new_user_alerts (guild_id, channel_id)
            VALUES (?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
        `).run(guildId, channel.id);

        await interaction.reply({
            content: `✅ New user alerts will now be sent to ${channel}`,
            flags: 64
        });
    } catch (error) {
        console.error('Error setting alert channel:', error);
        await interaction.reply({
            content: '❌ An error occurred while setting the alert channel.',
            flags: 64
        });
    }
});

// New User Alert System
client.on('guildMemberAdd', async member => {
    try {
        const accountAge = Date.now() - member.user.createdTimestamp;
        const daysOld = Math.floor(accountAge / (1000 * 60 * 60 * 24));

        if (daysOld < 30) {
            // Fetch alert channel from database
            const alertChannel = db.prepare(
                'SELECT channel_id FROM new_user_alerts WHERE guild_id = ?'
            ).get(member.guild.id);

            if (alertChannel) {
                const channel = member.guild.channels.cache.get(alertChannel.channel_id);
                if (channel && channel.isTextBased()) {
                    // Fetch staff roles from command_roles table
                    const staffRoles = db.prepare(
                        'SELECT role_id FROM command_roles WHERE guild_id = ?'
                    ).all(member.guild.id);

                    // Create role mentions string
                    const roleMentions = staffRoles.map(role => `<@&${role.role_id}>`).join(' ');

                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ New User Alert')
                        .setColor('#FF0000')
                        .setDescription([
                            `👤 **User:** ${member.user.tag}`,
                            `🆔 **ID:** ${member.user.id}`,
                            `📅 **Account Age:** ${daysOld} days`,
                            `⚠️ **Warning:** This account is less than 30 days old!`
                        ].join('\n'))
                        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                        .setTimestamp();

                    // Send the alert with role pings
                    await channel.send({
                        content: roleMentions ? `${roleMentions}` : null,
                        embeds: [embed]
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error in new user alert system:', error);
    }
});


// Open Ticket Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-openticket') return;

    // Create the select menu for ticket type
    const typeMenu = new StringSelectMenuBuilder()
        .setCustomId('selectTicketType')
        .setPlaceholder('Select the type of ticket')
        .addOptions([
            { label: 'Support', value: 'support', description: 'General support ticket' },
            { label: 'Report', value: 'report', description: 'Report a user or issue' }
        ]);

    const row = new ActionRowBuilder().addComponents(typeMenu);

    await interaction.reply({
        content: 'Please select the type of ticket:',
        components: [row],
        flags: 64
    });
});

// Handle ticket type selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    if (interaction.customId === 'selectTicketType') {
        const selectedType = interaction.values[0]; // Ensure selectedType is assigned

        if (selectedType === 'report') {
            // Show category selection for reports
            const reportCategories = new StringSelectMenuBuilder()
                .setCustomId('selectReportCategory')
                .setPlaceholder('Select a category for your report')
                .addOptions([
                    { label: 'Harassment', value: 'harassment' },
                    { label: 'Spam', value: 'spam' },
                    { label: 'Scam', value: 'scam' },
                    { label: 'Other', value: 'other' },
                ]);

            return interaction.reply({
                content: 'Please select a category for your report:',
                components: [new ActionRowBuilder().addComponents(reportCategories)],
                flags: 64,
            });
        } else {
            // Create a support ticket
            await createTicketChannel(interaction, selectedType); // Pass selectedType to function
        }
    }
});

// Handle report category selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    if (interaction.customId === 'selectReportCategory') {
        const selectedCategory = interaction.values[0]; // Capture selected category

        await createTicketChannel(interaction, 'report', selectedCategory); // Pass both type and category
    }
});

// Create a ticket channel
async function createTicketChannel(interaction, selectedType, selectedCategory = null) {
    const guild = interaction.guild;
    const user = interaction.user;
    const botId = interaction.client.user.id;
    const categoryName = selectedCategory ? `Report-${selectedCategory}` : selectedType;
    const channelName = `${categoryName}-${user.username}`;

    try {
        // Fetch ALL role IDs for this guild from the database
        const allRoles = getAllGuildRoles(guild.id);

        const permissionOverwrites = [
            {
                id: guild.id, // 🔒 Deny everyone from seeing the channel
                deny: [PermissionsBitField.Flags.ViewChannel]
            },
            {
                id: user.id, // ✅ Allow the ticket creator to see and send messages
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            },
            {
                id: botId, // ✅ Allow the bot full access
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels]
            }
        ];

        // ✅ Add ALL roles from the database (assumed as staff roles)
        for (const roleId of allRoles) {
            permissionOverwrites.push({
                id: roleId,
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            });
        }

        // 🔧 Create the private ticket channel
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            permissionOverwrites
        });

        await interaction.reply({
            content: `✅ Ticket created: <#${channel.id}> (Only visible to you and staff)`,
            flags: 64
        });

        await channel.send({
            content: `👋 Hello ${user}, please describe your issue or report. A staff member will assist you shortly.`,
        });

    } catch (error) {
        console.error("❌ Error creating ticket channel:", error);
        await interaction.reply({
            content: "❌ There was an error creating your ticket. Please try again later.",
            flags: 64
        });
    }
}

// Function to Fetch ALL Role IDs for This Guild
function getAllGuildRoles(guildId) {
    try {
        const rows = db.prepare(`SELECT role_id FROM command_roles WHERE guild_id = ?`).all(guildId);
        return rows.map(row => row.role_id); // Extract only role IDs
    } catch (error) {
        console.error("❌ Database Error:", error);
        return []; // Return an empty array if something goes wrong
    }
}

// Close Ticket Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-closeticket') return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const guildId = interaction.guild?.id;
    const channel = interaction.channel;
    const user = interaction.user;

    if (!guildId) {
        return interaction.reply({
            content: 'This command can only be used in a server.',
            flags: 64,
        });
    }

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to close this ticket.',
            flags: 64,
        });
    }

    try {
        // Fetch the log channel from the database
        console.log(`Fetching log channel for guild: ${guildId}`);
        const result = db.prepare('SELECT log_channel FROM guild_settings WHERE guild_id = ?').get(guildId);

        if (!result || !result.log_channel) {
            return interaction.reply({
                content: 'No log channel is set. Use `/tgc-setlogchannel` to set it.',
                flags: 64,
            });
        }

        const logChannelId = result.log_channel;
        const logChannel = interaction.guild.channels.cache.get(logChannelId);
        
        if (!logChannel) {
            return interaction.reply({
                content: 'The configured log channel is invalid or inaccessible. Please set it again.',
                flags: 64,
            });
        }

        // Fetch messages from the ticket channel
        const messages = await channel.messages.fetch({ limit: 100 });
        const transcript = messages
            .reverse()
            .map(msg => `[${new Date(msg.createdTimestamp).toLocaleString()}] ${msg.author.tag}: ${msg.content}`)
            .join('\n');

        // Save transcript to a file
        const fs = require('fs');
        const path = require('path');
        const logFolder = path.join(__dirname, 'ticket_logs');
        if (!fs.existsSync(logFolder)) fs.mkdirSync(logFolder);

        const transcriptPath = path.join(logFolder, `ticket-${channel.id}.txt`);
        fs.writeFileSync(transcriptPath, transcript);

        // Send the log file to the log channel
        await logChannel.send({
            content: `📝 **Ticket Closed**\n👤 **Closed By:** ${user.tag}\n📌 **Channel:** ${channel.name}`,
            files: [transcriptPath],
        });

        // Delete the ticket channel
        await channel.delete();

    } catch (error) {
        console.error('Error closing ticket:', error);
        return interaction.reply({
            content: 'An error occurred while closing the ticket. Please try again later.',
            flags: 64,
        });
    }
});

// Send Message Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-sendmessage") {
        const targetChannel = interaction.options.getChannel("channel");

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }
        if (!targetChannel.isTextBased()) {
            return interaction.reply({ content: "❌ You must select a text channel!", flags: 64 });
        }

        // Create a modal for message input
        const modal = new ModalBuilder()
            .setCustomId("sendmessage_modal")
            .setTitle("Send a Message");

        // Create a text input field for message content
        const messageInput = new TextInputBuilder()
            .setCustomId("message_content")
            .setLabel("Enter your message")
            .setStyle(TextInputStyle.Paragraph) // Allows multi-line messages
            .setPlaceholder("Type your message here...")
            .setRequired(true);

        // Add input to a row and add to the modal
        const row = new ActionRowBuilder().addComponents(messageInput);
        modal.addComponents(row);

        // Show the modal to the user
        await interaction.showModal(modal);

        // Store the target channel ID for later use
        client.tempChannelStore = client.tempChannelStore || {};
        client.tempChannelStore[interaction.user.id] = targetChannel.id;
    }
});

// Handle message submission from the modal
client.on("interactionCreate", async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === "sendmessage_modal") {
        const userId = interaction.user.id;

        // Retrieve the stored channel ID
        const targetChannelId = client.tempChannelStore?.[userId];
        if (!targetChannelId) {
            return interaction.reply({ content: "❌ No channel was selected.", flags: 64 });
        }

        const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel || !targetChannel.isTextBased()) {
            return interaction.reply({ content: "❌ The selected channel is no longer valid.", flags: 64 });
        }

        // Get the message content from the modal input
        const messageContent = interaction.fields.getTextInputValue("message_content");

        // Send the message
        await targetChannel.send(messageContent);

        // Remove stored channel ID after use
        delete client.tempChannelStore[userId];

        // Confirm to the user (hidden message)
        await interaction.reply({ content: `✅ Message sent to ${targetChannel}!`, flags: 64 });
    }
});

// Lock Channel Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-lock") {
        const targetChannel = interaction.options.getChannel("channel");

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

        if (!targetChannel.isTextBased()) {
            return interaction.reply({ content: "❌ This is not a text channel!"});
        }

        const everyoneRole = interaction.guild.roles.everyone;
        const permissions = targetChannel.permissionsFor(everyoneRole);

        if (permissions.has("SendMessages")) {
            await targetChannel.permissionOverwrites.edit(everyoneRole, { SendMessages: false });
            return interaction.reply({ content: `🔒 **Locked** ${targetChannel}! Only admins can send messages.`});
        } else {
            await targetChannel.permissionOverwrites.edit(everyoneRole, { SendMessages: true });
            return interaction.reply({ content: `🔓 **Unlocked** ${targetChannel}! Everyone can send messages again.`});
        }
    }
});

// ===============================
// Auto-Publishing & Forwarding
// ===============================

// Automatically publishes messages sent in announcement/news channels.
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-toggleautopublish") {
        const channel = interaction.options.getChannel("channel");

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

        // Ensure it's an announcement channel
        if (channel.type !== ChannelType.GuildAnnouncement) {
            return interaction.reply({ content: "❌ You can only toggle auto-publishing for announcement channels.", flags: 64 });
        }

        // Check current state
        const row = db.prepare("SELECT enabled FROM autopublish_channels WHERE channel_id = ?").get(channel.id);

        let newState;
        if (!row) {
            // If no record exists, enable auto-publishing by default
            db.prepare("INSERT INTO autopublish_channels (channel_id, enabled) VALUES (?, ?)").run(channel.id, 1);
            newState = true;
        } else {
            // Toggle the state
            newState = row.enabled ? 0 : 1;
            db.prepare("UPDATE autopublish_channels SET enabled = ? WHERE channel_id = ?").run(newState, channel.id);
        }

        interaction.reply({
            content: `✅ Auto-publishing is now **${newState ? "enabled" : "disabled"}** for <#${channel.id}>.`,
            flags: 64
        });

        console.log(`🔄 Auto-publishing toggled to ${newState ? "enabled" : "disabled"} for channel ${channel.id}`);
    }
});

// Auto-publishing system (checks per-channel toggle)
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Check if the message is in an announcement channel
    if (message.channel.type === ChannelType.GuildAnnouncement) {
        const channelId = message.channel.id;

        // Check if auto-publishing is enabled for this channel
        const row = db.prepare("SELECT enabled FROM autopublish_channels WHERE channel_id = ?").get(channelId);
        if (!row || row.enabled === 0) {
            console.log(`⏳ Auto-publishing is disabled for #${message.channel.name}. Skipping.`);
            return;
        }

        try {
            await message.crosspost(); // Publish the message
            console.log(`✅ Auto-published message in #${message.channel.name} (${message.guild.name})`);
        } catch (error) {
            console.error(`❌ Failed to auto-publish message in #${message.channel.name}:`, error);
        }
    }
});

// forward Channel Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-forward") {
        const sourceChannelId = interaction.options.getString("source_id");
        const targetChannelId = interaction.options.getString("target_id");
        const colorName = interaction.options.getString("color") || "Default (Teal)"; // Default color if none is chosen

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

        // Validate color choice
        const embedColor = EMBED_COLORS[colorName];
        if (!embedColor) {
            return interaction.reply({ content: `❌ Invalid color choice. Please use one of: ${Object.keys(EMBED_COLORS).join(", ")}`, flags: 64 });
        }

        // Validate channels
        const sourceChannel = await client.channels.fetch(sourceChannelId).catch(() => null);
        const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);

        if (!sourceChannel || !targetChannel) {
            return interaction.reply({ content: "❌ Invalid channel IDs or bot lacks access.", flags: 64 });
        }

        // Store in database
        db.prepare(`
            INSERT INTO channel_links (source_channel_id, target_channel_id, embed_color)
            VALUES (?, ?, ?)
            ON CONFLICT(source_channel_id) DO UPDATE SET target_channel_id = excluded.target_channel_id, embed_color = excluded.embed_color
        `).run(sourceChannelId, targetChannelId, embedColor);

        console.log(`✅ Channel forwarding set: ${sourceChannelId} → ${targetChannelId} with color ${colorName}`);

        interaction.reply({
            content: `✅ Messages from <#${sourceChannelId}> will now be forwarded to <#${targetChannelId}> with embed color **${colorName}**.`,
            flags: 64
        });
    }

    if (interaction.commandName === "tgc-removeforward") {
        const sourceChannelId = interaction.options.getString("source_id");

        // Validate source channel
        const sourceChannel = await client.channels.fetch(sourceChannelId).catch(() => null);
        if (!sourceChannel) {
            return interaction.reply({ content: "❌ Invalid source channel ID or bot lacks access.", flags: 64 });
        }

        // Remove from database
        const result = db.prepare("DELETE FROM channel_links WHERE source_channel_id = ?").run(sourceChannelId);

        if (result.changes > 0) {
            console.log(`❌ Forwarding removed: ${sourceChannelId}`);
            interaction.reply({
                content: `✅ Forwarding from <#${sourceChannelId}> has been removed.`,
                flags: 64
            });
        } else {
            interaction.reply({
                content: `⚠️ No forwarding rule found for <#${sourceChannelId}>.`,
                flags: 64
            });
        }
    }
});

// ✅ Debugging Message Listener
client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;
    
    console.log(`📩 Message detected in ${message.channel.id}: ${message.content}`);

    // Fetch target channel and embed color from DB
    const row = db.prepare("SELECT target_channel_id, embed_color FROM channel_links WHERE source_channel_id = ?").get(message.channel.id);
    
    if (!row) {
        console.log(`⚠️ No forwarding found for channel ${message.channel.id}`);
        return;
    }

    const targetChannel = await client.channels.fetch(row.target_channel_id).catch(() => null);
    if (!targetChannel) {
        console.log(`❌ Cannot fetch target channel: ${row.target_channel_id}`);
        return;
    }

    console.log(`➡️ Forwarding message to ${row.target_channel_id}`);

    // Convert embed color to integer (Discord expects a base 10 integer for color)
    const embedColorInt = parseInt(row.embed_color, 16);

    // Create an embed
    const embed = new EmbedBuilder()
        .setColor(embedColorInt)
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setTimestamp()
        .setFooter({ text: `From ${message.guild.name}` });

    if (message.content) embed.setDescription(message.content);

    const mediaUrls = message.attachments.map(attachment => attachment.url);
    if (mediaUrls.length > 0) {
        embed.setImage(mediaUrls[0]);
        if (mediaUrls.length > 1) targetChannel.send(mediaUrls.slice(1).join("\n"));
    }

    const messageLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
    const rowComponent = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel("View Original Message")
            .setStyle(ButtonStyle.Link)
            .setURL(messageLink)
    );

    targetChannel.send({ embeds: [embed], components: [rowComponent] }).catch(console.error);
});

// ===============================
//          Fun Commands
// ===============================

// Death Battle Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-deathbattle") {
        const fighter1 = interaction.options.getUser("fighter1");
        const fighter2 = interaction.options.getUser("fighter2");

        if (fighter1.id === fighter2.id) {
            return interaction.reply({ content: "❌ You cannot fight yourself!", flags: 64 });
        }

        // Fetch guild members to get nicknames and server avatars
        const member1 = await interaction.guild.members.fetch(fighter1.id).catch(() => null);
        const member2 = await interaction.guild.members.fetch(fighter2.id).catch(() => null);

        const fighter1Name = member1 ? member1.displayName : fighter1.username;
        const fighter2Name = member2 ? member2.displayName : fighter2.username;

        // Initialize battle stats
        let hp1 = 100, hp2 = 100; // Each fighter starts with 100 HP
        let turn = Math.random() < 0.5 ? 1 : 2; // Randomly decide who starts
        let battleLog = [];

        // List of battle GIFs
        const battleGifs = [
            "https://media1.tenor.com/m/xJlx-a0UlLcAAAAd/metal-gear-rising-raiden.gif",
            "https://media1.tenor.com/m/DrSELrunh9gAAAAC/black-blackman.gif",
            "https://media.tenor.com/K6DgsMs918UAAAAi/xqcsmash-rage.gif",
            "https://media1.tenor.com/m/p9_q4Bfmt8YAAAAd/two-people-fighting-fight.gif",
            "https://media1.tenor.com/m/qC6EyHfCQncAAAAd/rock-lee-gaara.gif",
            "https://media1.tenor.com/m/3_bw0IE43nQAAAAd/fawlty-towers-john-cleese.gif",
        ];
        // List of attack moves
        const attackMoves = [
            "Swings the OmniWrench with full force! 🔧💥",
            "Performs a Hyper-Strike with the OmniWrench! 🚀🔧",
            "Delivers a devastating Wrench Whirlwind attack! 🌀🔩",
            "Throws the OmniWrench like a boomerang! 🔄🔧",
            
            "Fires a Warmonger missile straight at the target! 🎯🚀",
            "Launches a Fusion Grenade right into the action! 💣🔥",
            "Unleashes a RYNO barrage, overwhelming the enemy! 🎶🔫",
            "Deploys the Mr. Zurkon drone to assist in battle! 🤖🔫",
            "Blasts with the B6-Obliterator, causing mass destruction! 💥💀",
        
            "Fires a devastating Plasma Coil shot! ⚡🔫",
            "Unleashes the Tesla Claw, shocking the target! ⚡⚡",
            "Charges up the Alpha Disruptor and obliterates everything! 💥🔵",
            "Fires a high-powered Arc Lasher beam! 🔥🔫",
        
            "Opens a Rift Tether, sending the enemy into another dimension! 🌌💀",
            "Summons an interdimensional rift that swallows the target! 🌠⚠️",
            "Uses the Quantum Repulsor to launch enemies into the air! 🚀🌀",
            "Fires the Temporal Repulsor, slowing time itself! ⏳🔫",
        
            "Deploys a Glove of Doom, unleashing mini killer-bots! 🤖💣",
            "Activates the Pixelizer, reducing the enemy to 8-bit pixels! 🕹️🔫",
            "Launches the Groovitron, forcing the enemy into a dance-off! 🕺🎶",
            "Deploys a Rift Inducer, summoning tentacles from another dimension! 👁️💀",
        
            "Drops an Omega-class Sheepinator bomb—baaaah! 🐑💥",
            "Fires the Magma Cannon, scorching everything in sight! 🔥🔫",
            "Summons a Meteor Strike using the Meteor Pad! ☄️💀",
            "Unleashes a complete RYNO V orchestra of destruction! 🎵💣💀"
        ];

        // Create initial embed with a random battle GIF
        const battleEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("⚔️ **DEATH BATTLE BEGINS!** ⚔️")
            .setDescription(`🔥 **${fighter1Name}** vs **${fighter2Name}** 🔥`)
            .addFields(
                { name: "🔥 Fighters", value: `🟥 **${fighter1Name}** (100 HP) vs 🟦 **${fighter2Name}** (100 HP)` },
                { name: "⚔️ Battle Log", value: "*The fight is about to begin...*" }
            )
            .setImage("http://media1.tenor.com/m/I7QkHH-wak4AAAAd/rumble-wwf.gif")
            .setFooter({ text: "Who will survive?" });

        await interaction.deferReply();
        await interaction.editReply({ embeds: [battleEmbed] });

        // Start the battle simulation
async function battleTurn() {
    if (hp1 <= 0 || hp2 <= 0) {
        let winner = hp1 > 0 ? fighter1 : fighter2;
        let loser = hp1 > 0 ? fighter2 : fighter1;
        let winnerName = hp1 > 0 ? fighter1Name : fighter2Name;
        let loserName = hp1 > 0 ? fighter2Name : fighter1Name;

        // Reward system: Random bolts between 20-50
        const minBolts = 200;
        const maxBolts = 500;
        const reward = Math.floor(Math.random() * (maxBolts - minBolts + 1)) + minBolts;

        // Update currency balance for the winner
        shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(reward, winner.id);

        // Update win/loss records in the database
        shopDB.prepare(`
            INSERT INTO deathbattle_stats (user_id, wins, losses)
            VALUES (?, 1, 0)
            ON CONFLICT(user_id) DO UPDATE SET wins = wins + 1;
        `).run(winner.id);

        shopDB.prepare(`
            INSERT INTO deathbattle_stats (user_id, wins, losses)
            VALUES (?, 0, 1)
            ON CONFLICT(user_id) DO UPDATE SET losses = losses + 1;
        `).run(loser.id);

        // Fetch winner's server avatar (fallback to global avatar)
        const winnerMember = await interaction.guild.members.fetch(winner.id).catch(() => null);
        const winnerAvatar = winnerMember && winnerMember.avatar
            ? winnerMember.displayAvatarURL({ dynamic: true, size: 512 }) // Server avatar
            : winner.displayAvatarURL({ dynamic: true, size: 512 }); // Global avatar fallback

        let finalBlow = `💀 **FINAL BLOW!** ${winnerName} lands a devastating strike and claims victory!`;

        battleEmbed
            .setColor("#00ff00")
            .setTitle("🏆 **VICTORY!** 🏆")
            .setDescription(finalBlow)
            .addFields(
                { name: "👑 Winner:", value: `🎉 **${winnerName}** emerges victorious!` },
                { name: "⚙️ Reward:", value: ` **${reward}** Bolts!` },
                { name: "📊 Record:", value: `**${winnerName}:** 🏆 +1 Win\n**${loserName}:** ❌ +1 Loss` }
            )
            .setThumbnail(winnerAvatar)
            .setFooter({ text: "Who will battle next?" });

        return interaction.editReply({ embeds: [battleEmbed] });
    }

    let attacker = turn === 1 ? fighter1Name : fighter2Name;
    let defender = turn === 1 ? fighter2Name : fighter1Name;
    let damage = Math.floor(Math.random() * 11) + 5; // Random damage 5-15
    let crit = Math.random() < 0.05; // 5% chance for a critical hit

    if (crit) {
        damage *= 2;
        battleLog.push(`💥 **CRITICAL HIT!** ${attacker} ${attackMoves[Math.floor(Math.random() * attackMoves.length)]} dealing **${damage} HP!**`);
    } else {
        battleLog.push(`⚔️ ${attacker} ${attackMoves[Math.floor(Math.random() * attackMoves.length)]} dealing **${damage} HP** to ${defender}!`);
    }

    if (turn === 1) {
        hp2 -= damage;
        turn = 2; // Switch turns
    } else {
        hp1 -= damage;
        turn = 1;
    }

    let battleStatus = `🟥 **${fighter1Name}** (${Math.max(hp1, 0)} HP) vs 🟦 **${fighter2Name}** (${Math.max(hp2, 0)} HP)`;
    let latestLog = battleLog.slice(-5).join("\n") || "*No attacks yet.*"; // Show last 5 logs

    // Update embed with random battle GIF
    battleEmbed
        .setTitle("⚔️ **DEATH BATTLE!** ⚔️")
        .setDescription(`🔥 **${fighter1Name}** vs **${fighter2Name}**`)
        .setFields(
            { name: "💥 Current Health", value: battleStatus },
            { name: "⚔️ Battle Log", value: latestLog }
        )
        .setImage(battleGifs[Math.floor(Math.random() * battleGifs.length)]) // Randomly pick a new GIF each turn
        .setFooter({ text: "Next attack incoming..." });

    await interaction.editReply({ embeds: [battleEmbed] });

    if (hp1 > 0 && hp2 > 0) {
        setTimeout(battleTurn, 1000); // Delay for next turn
    } else {
        setTimeout(battleTurn, 3000); // Slightly longer delay for final blow
    }
}

// Start the first turn
setTimeout(battleTurn, 3000);
    }
});

// 8ball Command
const responses = [
    "Yes! ✅", "No. ❌", "Maybe... 🤔", "Absolutely!", 
    "Not likely.", "Ask again later. ⏳", "Definitely!", "I wouldn't count on it."
];

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-8ball") {
        const question = interaction.options.getString("question");
        if (!question) return interaction.reply({ content: "❓ You must ask a question!", flags: 64 });

        const response = responses[Math.floor(Math.random() * responses.length)];
        await interaction.reply({ content: `🎱 **Question:** ${question}\n🔮 **Answer:** ${response}`});
    }
});

// Random Quote Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-randomquote") {
        // Fetch a random quote from the database
        const quote = db.prepare("SELECT text FROM quotes ORDER BY RANDOM() LIMIT 1").get();

        if (!quote) {
            return interaction.reply({ content: "❌ No quotes found! Use `/tgc-addquote` to add one.", flags: 64 });
        }

        await interaction.reply({ content: `📜 **Random Quote:** ${quote.text}`});
    }
});

// Add Quote Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-addquote") {

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }
        // Create the modal
        const modal = new ModalBuilder()
            .setCustomId("addquote_modal")
            .setTitle("Add a New Quote");

        // Create a text input field
        const quoteInput = new TextInputBuilder()
            .setCustomId("quote_content")
            .setLabel("Enter the quote")
            .setStyle(TextInputStyle.Paragraph) // Multi-line input
            .setPlaceholder("Type the quote here...")
            .setRequired(true);

        // Add input to a row and then to the modal
        const row = new ActionRowBuilder().addComponents(quoteInput);
        modal.addComponents(row);

        // Show the modal
        await interaction.showModal(modal);
    }
});

// Handle quote submission from the modal
client.on("interactionCreate", async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === "addquote_modal") {
        const quoteText = interaction.fields.getTextInputValue("quote_content");

        // Insert into database
        db.prepare("INSERT INTO quotes (text) VALUES (?)").run(quoteText);

        // Confirm success
        await interaction.reply({ content: `✅ Quote added: "${quoteText}"`, flags: 64 });
    }
});

// List Quotes Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-listquotes") {
        const quotes = db.prepare("SELECT id, text FROM quotes").all();

        if (quotes.length === 0) {
            return interaction.reply({ content: "❌ No quotes found!", flags: 64 });
        }

        const quoteList = quotes.map(q => `**#${q.id}:** ${q.text}`).join("\n");

        await interaction.reply({ content: `📜 **Stored Quotes:**\n${quoteList}`});
    }
});

// Delete Quote Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-deletequote") {
        const quoteId = interaction.options.getInteger("id");

        // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

        const deleted = db.prepare("DELETE FROM quotes WHERE id = ?").run(quoteId);

        if (deleted.changes === 0) {
            return interaction.reply({ content: `❌ No quote found with ID **${quoteId}**!`, flag: 64 });
        }

        await interaction.reply({ content: `✅ Deleted quote **#${quoteId}**!`});
    }
});

// ============
// Shop System
// ============

const CURRENCY_NAME = "Bolts"; // Change this to whatever you want
const CURRENCY_EMOJI = "⚙️"; // Optional emoji

// Balance Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-balance") {
        const userId = interaction.user.id;

        //  Fetch balance from `shopDB`
        let userData = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(userId);
        if (!userData) {
            shopDB.prepare("INSERT INTO user_currency (user_id, balance) VALUES (?, ?)").run(userId, 0);
            userData = { balance: 0 };
        }

        const userBalance = parseInt(userData.balance, 10); //  Ensure balance is an integer

        return interaction.reply({ 
            content: `💰 **${interaction.user.username}**, you have **${userBalance} ${CURRENCY_NAME} ${CURRENCY_EMOJI}**.`,
            flags: 64 
        });
    }
});

// Earn Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-give-currency") {
        // ✅ Permission Check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: '❌ You do not have permission to use this command.',
                flags: 64
            });
        }

        const targetUser = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");

        if (!targetUser) {
            return interaction.reply({ content: "❌ You must specify a valid user.", flags: 64 });
        }

        if (amount <= 0) {
            return interaction.reply({ content: "❌ Amount must be greater than zero.", flags: 64 });
        }

        // ✅ Ensure the user exists in the `shopDB`
        let userData = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(targetUser.id);
        if (!userData) {
            shopDB.prepare("INSERT INTO user_currency (user_id, balance) VALUES (?, ?)").run(targetUser.id, 0);
        }

        // ✅ Update or insert balance
        shopDB.prepare(`
            INSERT INTO user_currency (user_id, balance) 
            VALUES (?, ?) 
            ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?
        `).run(targetUser.id, amount, amount);

        await interaction.reply({
            content: `✅ Successfully **gave ${amount} ${CURRENCY_NAME} ${CURRENCY_EMOJI}** to **${targetUser.username}**.`,
            flags: 64
        });
    }
});

// Shop Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-shop") {
        // Fetch categories
        const categories = shopDB.prepare("SELECT DISTINCT category FROM shop_items").all();
        if (categories.length === 0) {
            return interaction.reply({ content: "❌ The shop is currently empty!", flags: 64 });
        }

        // Create category dropdown
        const categoryOptions = categories.map(cat => ({
            label: cat.category,
            value: cat.category
        }));

        const categoryMenu = new StringSelectMenuBuilder()
            .setCustomId("shop_category")
            .setPlaceholder("Select a category")
            .addOptions(categoryOptions);

        const actionRow = new ActionRowBuilder().addComponents(categoryMenu);

        return interaction.reply({
            content: "🛒 **Welcome to the Shop!** Select a category:",
            components: [actionRow],
            flags: 64
        });
    }
});

// Shop category selection
client.on("interactionCreate", async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "shop_category") return;

    const category = interaction.values[0];

    // Fetch items from selected category
    const items = shopDB.prepare("SELECT * FROM shop_items WHERE category = ?").all(category);
    if (items.length === 0) {
        return interaction.reply({ content: "❌ No items found in this category.", flags: 64 });
    }

    const itemOptions = items.map(item => ({
        label: `${item.name} - ${item.price} ${CURRENCY_NAME} ${CURRENCY_EMOJI}`,
        value: item.item_id.toString(),
        description: item.description
    }));

    const itemMenu = new StringSelectMenuBuilder()
        .setCustomId("shop_items")
        .setPlaceholder("Select an item to purchase")
        .addOptions(itemOptions);

    const actionRow = new ActionRowBuilder().addComponents(itemMenu);

    return interaction.update({
        content: `📂 **Category:** ${category}\n🛒 Select an item to purchase:`,
        components: [actionRow]
    });
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "shop_items") return;
    const userId = interaction.user.id;
    const itemId = parseInt(interaction.values[0]);
    const item = shopDB.prepare("SELECT * FROM shop_items WHERE item_id = ?").get(itemId);
    if (!item) {
        return interaction.reply({ content: "❌ This item no longer exists.", flags: 64 });
    }

    const confirmButton = new ButtonBuilder()
    .setCustomId(`shop_confirm_purchase_${itemId}_${userId}`) // Must include the buyer's ID
    .setLabel("✅ Confirm Purchase")
    .setStyle(ButtonStyle.Success);


    const actionRow = new ActionRowBuilder().addComponents(confirmButton);

    const embed = new EmbedBuilder()
        .setTitle(`🛒 ${item.name}`)
        .setDescription(item.description)
        .setImage(item.image_url || null)
        .setFooter({ text: `Price: ${item.price} ${CURRENCY_NAME} ${CURRENCY_EMOJI}` })
        .setColor("#FFD700");

    return interaction.update({
        embeds: [embed],
        components: [actionRow]
    });
});

// Handle Purchase Confirmation
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return; // Ensure it's a button interaction
    if (!interaction.customId) return; // Ensure customId exists

    // ✅ Ensure this only applies to shop purchases
    if (!interaction.customId.startsWith("shop_confirm_purchase_")) return;

    const args = interaction.customId.split("_");
    if (args.length < 5) {
        return interaction.reply({ content: "❌ Invalid interaction data.", flags: 64 });
    }

    const itemId = parseInt(args[3]);
    const confirmUserId = args[4];

    if (!itemId || !confirmUserId) {
        return interaction.reply({
            content: "❌ Invalid interaction data.",
            flags: 64,
        });
    }

    if (interaction.user.id !== confirmUserId) {
        return interaction.reply({
            content: "❌ You cannot confirm someone else's purchase!",
            flags: 64,
        });
    }

    const item = shopDB.prepare("SELECT * FROM shop_items WHERE item_id = ?").get(itemId);
    if (!item) {
        return interaction.update({
            content: "❌ This item is no longer available.",
            components: [],
            flags: 64
        }).catch(console.error); // Prevent crash if interaction is already replied
    }

    let userData = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(interaction.user.id);
    if (!userData) {
        shopDB.prepare("INSERT INTO user_currency (user_id, balance) VALUES (?, ?)").run(interaction.user.id, 0);
        userData = { balance: 0 };
    }

    if (userData.balance < item.price) {
        return interaction.update({
            content: `❌ Not enough currency! You need **${item.price} 💰**.`,
            components: [],
            flags: 64
        }).catch(console.error);
    }

    // 🚨 Prevent duplicate purchases
    const existingItem = shopDB.prepare("SELECT * FROM user_inventory WHERE user_id = ? AND item_id = ?").get(interaction.user.id, itemId);
    if (existingItem) {
        return interaction.update({
            content: "❌ You already own this item!",
            components: [],
            flags: 64
        }).catch(console.error);
    }

    // ✅ Process purchase
    try {
        shopDB.prepare("UPDATE user_currency SET balance = balance - ? WHERE user_id = ?").run(item.price, interaction.user.id);
        shopDB.prepare("INSERT INTO user_inventory (user_id, item_id) VALUES (?, ?)").run(interaction.user.id, itemId);

        await interaction.update({
            content: `✅ You successfully purchased **${item.name}** for **${item.price} 💰!**`,
            components: [],
        }).catch(console.error);
    } catch (error) {
        console.error("Purchase Error:", error);
        return interaction.update({
            content: "❌ An error occurred while processing your purchase. Please try again.",
            components: [],
            flags: 64
        }).catch(console.error);
    }
});

// additem Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-additem") {
        // Admin-only check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({ content: "❌ You don't have permission to add items.", flags: 64 });
        }

        const name = interaction.options.getString("name");
        const description = interaction.options.getString("description");
        const price = interaction.options.getInteger("price");
        const category = interaction.options.getString("category");
        const imageUrl = interaction.options.getString("image") || null;

        // Insert into shopDB
        shopDB.prepare(`
            INSERT INTO shop_items (name, description, price, category, image_url) VALUES (?, ?, ?, ?, ?)
        `).run(name, description, price, category, imageUrl);

        return interaction.reply({ content: `✅ Added **${name}** to the shop!`, flags: 64 });
    }
});

// inventory Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-inventory") {
        const userId = interaction.user.id;
        const guild = interaction.guild;

        // Fetch the user's server profile picture
        const member = await guild.members.fetch(userId).catch(() => null);
        const profilePicture = member && member.avatar
            ? `https://cdn.discordapp.com/guilds/${guild.id}/users/${userId}/avatars/${member.avatar}.png?size=512`
            : interaction.user.displayAvatarURL({ dynamic: true });

        // Fetch the user's inventory
        const items = shopDB.prepare(`
            SELECT si.name, si.price
            FROM user_inventory ui 
            JOIN shop_items si ON ui.item_id = si.item_id 
            WHERE ui.user_id = ?
        `).all(userId);

        if (!items.length) {
            return interaction.reply({
                content: "🛒 Your inventory is empty! Purchase items from the shop using `/tgc-shop`.",
                flags: 64
            });
        }

        // Pagination setup
        let page = 0;
        const itemsPerPage = 5;
        const totalPages = Math.ceil(items.length / itemsPerPage);

        function generateEmbed(page) {
            const start = page * itemsPerPage;
            const end = start + itemsPerPage;
            const pageItems = items.slice(start, end);

            const embed = new EmbedBuilder()
                .setColor("#FFD700")
                .setTitle(`${member ? member.displayName : interaction.user.username}'s Inventory`)
                .setThumbnail(profilePicture) // ✅ Uses server profile picture
                .setDescription("🎒 Here are the items you own:")
                .setFooter({ text: `Page ${page + 1} of ${totalPages}` });

            // Add items to the embed (WITHOUT images)
            pageItems.forEach((item) => {
                embed.addFields({
                    name: `🛍️ ${item.name}`,
                    value: `💰 Price: **${item.price}**`,
                    inline: true
                });
            });

            return embed;
        }

        // If there's only one page, just send the embed
        if (totalPages === 1) {
            return interaction.reply({ embeds: [generateEmbed(0)]});
        }

        // Pagination buttons
        const prevButton = new ButtonBuilder()
            .setCustomId("prev_inventory")
            .setLabel("◀️ Previous")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 0);

        const nextButton = new ButtonBuilder()
            .setCustomId("next_inventory")
            .setLabel("Next ▶️")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === totalPages - 1);

        const row = new ActionRowBuilder().addComponents(prevButton, nextButton);

        const replyMessage = await interaction.reply({ embeds: [generateEmbed(page)], components: [row]});

        // Collector for pagination
        const collector = replyMessage.createMessageComponentCollector({
            filter: (i) => i.user.id === interaction.user.id,
            time: 60000
        });

        collector.on("collect", async (i) => {
            if (i.customId === "prev_inventory" && page > 0) {
                page--;
            } else if (i.customId === "next_inventory" && page < totalPages - 1) {
                page++;
            }

            prevButton.setDisabled(page === 0);
            nextButton.setDisabled(page === totalPages - 1);

            await i.update({ embeds: [generateEmbed(page)], components: [row] });
        });

        collector.on("end", async () => {
            prevButton.setDisabled(true);
            nextButton.setDisabled(true);
            await interaction.editReply({ components: [row] });
        });
    }
});

// earning currency
const messageCooldown = new Map();

client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const now = Date.now();
    const cooldownTime = 60000; // 1 minute cooldown

    if (messageCooldown.has(userId)) {
        const lastMessageTime = messageCooldown.get(userId);
        if (now - lastMessageTime < cooldownTime) return; // Ignore messages within cooldown
    }
    
    messageCooldown.set(userId, now);

    const earnAmount = Math.floor(Math.random() * 5) + 1; // Earn between 1-5 currency
    shopDB.prepare("INSERT INTO user_currency (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?")
      .run(userId, earnAmount, earnAmount);

    console.log(`💰 ${message.author.username} earned ${earnAmount} currency for activity.`);
});

// =============
// Gambling
// =============

// Slot Machine
const slotCooldowns = new Map(); // Track cooldowns for slots

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-slots") {
        const betAmount = interaction.options.getInteger("amount");
        const userId = interaction.user.id;

        if (betAmount <= 0) {
            return interaction.reply({ content: "❌ Bet must be greater than zero!", flags: 64 });
        }

        // Check balance
        const userBalance = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(userId)?.balance || 0;
        if (userBalance < betAmount) {
            return interaction.reply({ content: "❌ You don't have enough bolts to bet!", flags: 64 });
        }

        // Check cooldown
        if (slotCooldowns.has(userId)) {
            return interaction.reply({ content: "⏳ You must wait before spinning again!", flags: 64 });
        }

        // Deduct bet
        shopDB.prepare("UPDATE user_currency SET balance = balance - ? WHERE user_id = ?").run(betAmount, userId);

       // 🎰 Ratchet & Clank Slot Symbols
        const symbols = ["🔧", "🤖", "🔫", "⚙️", "🚀", "🌌", "🎶"];
        const roll = () => symbols[Math.floor(Math.random() * symbols.length)];


        // Spin the slots
        const slot1 = roll();
        const slot2 = roll();
        const slot3 = roll();

        let winnings = 0;
        if (slot1 === slot2 && slot2 === slot3) {
            winnings = betAmount * 10; // Jackpot win
        } else if (slot1 === slot2 || slot2 === slot3 || slot1 === slot3) {
            winnings = betAmount * 2; // Small win
        }

        // Update balance if user wins
        if (winnings > 0) {
            shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(winnings, userId);
        } else {
            // Contribute lost bets to jackpot
            contributeToJackpot(betAmount);
        }

        // Apply cooldown
        slotCooldowns.set(userId, true);
        setTimeout(() => slotCooldowns.delete(userId), 5000);

        // Check jackpot win chance
        checkJackpotWin(userId, interaction.channel);

        // Embed result
        const slotEmbed = new EmbedBuilder()
            .setTitle("🎰 Slot Machine!")
            .setDescription(`🎲 You rolled: **${slot1} | ${slot2} | ${slot3}**`)
            .setColor(winnings > 0 ? "#00FF00" : "#FF0000")
            .setFooter({ text: winnings > 0 ? `You won ⚙️ ${winnings}!` : "Better luck next time!" });

        return interaction.reply({ embeds: [slotEmbed]});
    }
});

// Roulette
const spinCooldowns = new Map(); // Track user cooldowns for roulette

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-roulette") {
        const betAmount = interaction.options.getInteger("amount");
        const userId = interaction.user.id;

        if (betAmount <= 0) {
            return interaction.reply({ content: "❌ Bet must be greater than zero!", flags: 64 });
        }

        // Check user balance
        const userBalance = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(userId)?.balance || 0;
        if (userBalance < betAmount) {
            return interaction.reply({ content: "❌ You don't have enough bolts to bet!", flags: 64 });
        }

        // Bet selection dropdown
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`roulette_bet_${betAmount}`)
            .setPlaceholder("Select a bet type")
            .addOptions([
                { label: "Red", value: "red", emoji: "🟥" },
                { label: "Black", value: "black", emoji: "⬛" },
                { label: "Green (0)", value: "green", emoji: "🟩" }
            ]);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: "🎡 Place your bet:",
            components: [row],
            flags: 64
        });
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith("roulette_bet_")) return;

    const userId = interaction.user.id;
    const selectedBet = interaction.values[0];
    const betAmount = parseInt(interaction.customId.split("_")[2]);

    // Check cooldown
    if (spinCooldowns.has(userId)) {
        return interaction.reply({ content: "⏳ You must wait before spinning again!", flags: 64 });
    }

    // Deduct bet
    shopDB.prepare("UPDATE user_currency SET balance = balance - ? WHERE user_id = ?").run(betAmount, userId);

    // Simulate spin
    const winningNumber = Math.floor(Math.random() * 37);
    const winningColor = winningNumber === 0 ? "green" : winningNumber % 2 === 0 ? "red" : "black";

    let winnings = 0;
    if (selectedBet === winningColor) {
        winnings = betAmount * 2;
    } else if (selectedBet === "green" && winningNumber === 0) {
        winnings = betAmount * 14;
    }

    // Update balance if user wins
    if (winnings > 0) {
        shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(winnings, userId);
    } else {
        // Contribute lost bets to jackpot
        contributeToJackpot(betAmount);
    }

    // Apply cooldown
    spinCooldowns.set(userId, true);
    setTimeout(() => spinCooldowns.delete(userId), 5000);

    // Check jackpot win chance
    checkJackpotWin(userId, interaction.channel);

    // Embed result
    const rouletteEmbed = new EmbedBuilder()
        .setTitle("🎡 Roulette Spin!")
        .setDescription(`🎲 Winning Number: **${winningNumber}** (${winningColor.toUpperCase()})`)
        .setColor(winnings > 0 ? "#00FF00" : "#FF0000")
        .setFooter({ text: winnings > 0 ? `You won ⚙️ ${winnings}!` : "Better luck next time!" });

    return interaction.reply({ embeds: [rouletteEmbed]});
});

//bolt crates
const boltCrateChances = 0.02; // 2% chance per message
const boltCrates = [
    { name: "Small Crate", min: 50, max: 200, color: "#C0C0C0" },    // Silver
    { name: "Medium Crate", min: 200, max: 500, color: "#FFD700" },  // Gold
    { name: "Large Crate", min: 500, max: 1000, color: "#FF0000" }   // Red
];

client.on("messageCreate", async (message) => {
    if (message.author.bot) return; // Ignore bot messages

    if (Math.random() < boltCrateChances) {
        const crate = boltCrates[Math.floor(Math.random() * boltCrates.length)];
        const bolts = Math.floor(Math.random() * (crate.max - crate.min + 1)) + crate.min;

        const embed = new EmbedBuilder()
            .setTitle("A Bolt Crate Appeared!")
            .setDescription(`Click the button below to claim the **${crate.name}** and receive bolts!`)
            .addFields({ name: "🔧 Possible Reward:", value: ` **${crate.min} - ${crate.max}** Bolts` })
            .setColor(crate.color) // Now uses the color specific to the crate rarity
            .setThumbnail("https://static.wikia.nocookie.net/ratchet/images/0/0e/Bolt_crate_from_R%26C_%282002%29_render.png") // Replace with actual image URL

        const button = new ButtonBuilder()
            .setCustomId(`claim_bolt_crate_${bolts}`)
            .setLabel("🔧 Claim Crate")
            .setStyle(ButtonStyle.Success);

        const actionRow = new ActionRowBuilder().addComponents(button);

        await message.channel.send({
            embeds: [embed],
            components: [actionRow]
        });
    }
});

// Handle Bolt Crate Claim
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("claim_bolt_crate_")) return;

    const bolts = parseInt(interaction.customId.split("_")[3]);
    const userId = interaction.user.id;

    shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?")
        .run(bolts, userId);

    const embed = new EmbedBuilder()
        .setTitle("✅ Bolt Crate Claimed!")
        .setDescription(`**${interaction.user.username}** has claimed the crate and received **${bolts} bolts**!`)
        .setColor("#00FF00")
        .setThumbnail("https://static.wikia.nocookie.net/ratchet/images/0/0e/Bolt_crate_from_R%26C_%282002%29_render.png"); // Replace with actual image URL

    await interaction.update({
        embeds: [embed],
        components: []
    });
});

const mysteryCrateChances = 0.005; // .5% chance per message
const mysteryCrates = {
    common: {
        name: "Common Mystery Crate",
        color: "#AAAAAA",
        image: "https://static.wikia.nocookie.net/ratchet/images/5/53/Ammo_crate_from_UYA_render.png",
        boltReward: [50, 150], // Min-Max bolts
        priceRange: [0, 500] // Items worth up to 500 bolts
    },
    rare: {
        name: "Rare Mystery Crate",
        color: "#1E90FF",
        image: "https://static.wikia.nocookie.net/ratchet/images/5/53/Ammo_crate_from_UYA_render.png",
        boltReward: [200, 500],
        priceRange: [500, 1500]
    },
    legendary: {
        name: "Legendary Mystery Crate",
        color: "#FFD700",
        image: "https://static.wikia.nocookie.net/ratchet/images/5/53/Ammo_crate_from_UYA_render.png",
        boltReward: [1000, 2500],
        priceRange: [1500, Infinity]
    }
};

client.on("messageCreate", async (message) => {
    if (message.author.bot) return; // Ignore bot messages

    if (Math.random() < mysteryCrateChances) {
        const rarity = ["common", "rare", "legendary"][Math.floor(Math.random() * 3)];
        const crate = mysteryCrates[rarity];

        const embed = new EmbedBuilder()
            .setTitle(`🌀 A ${crate.name} Appeared!`)
            .setDescription(`Click the button below to **open the crate** and claim your reward!`)
            .setColor(crate.color)
            .setThumbnail(crate.image);

        const button = new ButtonBuilder()
            .setCustomId(`open_mystery_crate_${rarity}`)
            .setLabel("Open Crate")
            .setStyle(ButtonStyle.Primary);

        const actionRow = new ActionRowBuilder().addComponents(button);

        await message.channel.send({
            embeds: [embed],
            components: [actionRow]
        });
    }
});

// Handle Mystery Crate Opening
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("open_mystery_crate_")) return;

    const rarity = interaction.customId.split("_")[3];
    const userId = interaction.user.id;
    const crate = mysteryCrates[rarity];

    let reward;
    if (Math.random() < 0.5) { // 50% chance for bolts, 50% for an item
        // 🎉 Bolt Reward
        const bolts = Math.floor(Math.random() * (crate.boltReward[1] - crate.boltReward[0] + 1)) + crate.boltReward[0];
        shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(bolts, userId);
        reward = ` **${bolts} bolts**`;
    } else {
        //  Item Reward
        const items = shopDB.prepare("SELECT item_id, name FROM shop_items WHERE price BETWEEN ? AND ?").all(crate.priceRange[0], crate.priceRange[1]);

        if (items.length > 0) {
            const item = items[Math.floor(Math.random() * items.length)];

            //  Check if user already owns the item
            const existingItem = shopDB.prepare("SELECT * FROM user_inventory WHERE user_id = ? AND item_id = ?").get(userId, item.item_id);

            if (existingItem) {
                reward = `🔄 **Duplicate item detected!** You already own **${item.name}**.\nYou received **${crate.boltReward[0]} bolts instead!**`;
                shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(crate.boltReward[0], userId);
            } else {
                shopDB.prepare("INSERT INTO user_inventory (user_id, item_id) VALUES (?, ?)").run(userId, item.item_id);
                reward = ` **${item.name}**`;
            }
        } else {
            reward = ` **${crate.boltReward[0]} bolts** (No items available in this price range)`;
            shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(crate.boltReward[0], userId);
        }
    }

    const embed = new EmbedBuilder()
        .setTitle(`🎉 ${interaction.user.username} Opened a ${crate.name}!`)
        .setDescription(`They received **${reward}**!`)
        .setColor(crate.color)
        .setThumbnail(crate.image);

    await interaction.update({
        embeds: [embed],
        components: []
    });
});

// Add lost bets to the jackpot pool
function contributeToJackpot(amount) {
    shopDB.prepare("UPDATE jackpot SET amount = amount + ? WHERE id = 1").run(amount);
    console.log(`⚙️ Added ${amount} to the jackpot!`);
}

// Check if a user wins the jackpot
function checkJackpotWin(userId) {
    const jackpotAmount = shopDB.prepare("SELECT amount FROM jackpot WHERE id = 1").get()?.amount || 0;

    // 5% chance to win the jackpot
    if (Math.random() < 0.05 && jackpotAmount > 0) {
        announceJackpotWin(userId, jackpotAmount);
        shopDB.prepare("UPDATE jackpot SET amount = 0 WHERE id = 1").run(); // Reset jackpot
    }
}

// Announce jackpot win and give winnings
async function announceJackpotWin(userId, amount, channel) {
    // Update user's balance
    shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(amount, userId);
    
    // Send announcement in channel
    if (channel) {
        await channel.send({
            content: `🎉 Congratulations <@${userId}>! You won the jackpot of **⚙️ ${amount}** bolts! 🎰`,
            allowedMentions: { users: [userId] }
        }).catch(console.error);
    }
    
    console.log(`🎊 Jackpot won by ${userId}: ⚙️ ${amount}`);
}

// In-memory cooldown map
const xpCooldowns = new Map();

// XP Tracking
client.on('messageCreate', (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;

    // Cooldown check (60 seconds by default)
    const cooldown = 60000; // 60 seconds in milliseconds
    const now = Date.now();
    if (xpCooldowns.has(userId) && now - xpCooldowns.get(userId) < cooldown) {
        return; // User is on cooldown
    }

    xpCooldowns.set(userId, now); // Update cooldown timestamp

    // Fetch base XP and multiplier globally
    const settings = db.prepare(`
        SELECT base_xp, multiplier FROM guild_settings WHERE guild_id = 'global'
    `).get() || { base_xp: 300, multiplier: 1.2 };

    const { base_xp: baseXp, multiplier } = settings;

    if (!baseXp || !multiplier) {
        console.error("Base XP or multiplier is missing from the settings.");
        return;
    }

    // XP gain logic: Generate random XP gain between 1 and 5
    const xpGain = parseFloat((Math.random() * (20 - 5) + 5).toFixed(2));

    // Update or insert XP for the user
    db.prepare(`
        INSERT INTO user_xp (user_id, xp)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp
    `).run(userId, xpGain);

    // Fetch total XP for the user
    const { xp: totalXp } = db.prepare(`
        SELECT xp FROM user_xp WHERE user_id = ?
    `).get(userId);

    // Calculate the user's current level
    const level = calculateLevel(totalXp, baseXp, multiplier);

    console.log(`User '${message.author.username}' gained ${xpGain} XP, has ${totalXp.toFixed(2)} total XP, and is level ${level}.`);

    // Guild-specific role assignment logic
const rows = db.prepare(`
    SELECT level, role_id FROM level_roles WHERE guild_id = ?
`).all(message.guild.id);

// Sort roles by level in ascending order
rows.sort((a, b) => a.level - b.level);

const rolesToRemove = [];
let highestRole = null;

rows.forEach(({ level: requiredLevel, role_id }) => {
    const role = message.guild.roles.cache.get(role_id);
    if (role) {
        if (level >= requiredLevel) {
            highestRole = role; // Keep track of the highest role user qualifies for
        } else {
            rolesToRemove.push(role); // Collect roles that should be removed
        }
    }
});

// Assign and remove roles
const member = message.guild.members.cache.get(userId);
    if (member) {
    // Remove all level roles except the highestRole
    rows.forEach(({ role_id }) => {
        const role = message.guild.roles.cache.get(role_id);
        if (role && member.roles.cache.has(role.id) && role !== highestRole) {
            member.roles.remove(role).then(() => {
                console.log(`Removed role '${role.name}' from '${message.author.username}'.`);
            }).catch(err => {
                console.error(`Error removing role '${role.name}':`, err);
            });
        }
    });

    // Assign the highest qualifying role
    if (highestRole && !member.roles.cache.has(highestRole.id)) {
        member.roles.add(highestRole).then(() => {
            console.log(`Assigned role '${highestRole.name}' to '${message.author.username}'.`);
        }).catch(err => {
            console.error(`Error assigning role '${highestRole.name}':`, err);
        });
    }
}

});

// Leaderboard
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-xpleaderboard") {
        await interaction.deferReply(); // Prevents timeout while fetching usernames

        const perPage = 10;
        const totalUsers = db.prepare(`SELECT COUNT(*) AS count FROM user_xp`).get().count;
        const totalPages = Math.ceil(totalUsers / perPage);

        let page = 0;
        const getLeaderboardPage = (page) => {
            return db.prepare(`
                SELECT user_id, xp 
                FROM user_xp 
                ORDER BY xp DESC 
                LIMIT ? OFFSET ?
            `).all(perPage, page * perPage);
        };

        let leaderboardData = getLeaderboardPage(page);
        if (leaderboardData.length === 0) {
            return interaction.editReply({ content: "📉 No XP data found!", flags: 64 });
        }

        const generateEmbed = async (page) => {
            const leaderboardEmbed = new EmbedBuilder()
                .setColor("#FFD700")
                .setTitle("🏆 XP Leaderboard")
                .setDescription(`Top users with the highest XP (Page **${page + 1}** of **${totalPages}**)`)
                .setTimestamp()
                .setFooter({ text: `Page ${page + 1} of ${totalPages}` });

            // Fetch user info and add fields to the embed
            for (const [index, user] of leaderboardData.entries()) {
                let displayName;
                try {
                    const member = await interaction.guild.members.fetch(user.user_id);
                    displayName = member ? member.displayName : `Unknown Member (${user.user_id})`;
                } catch (err) {
                    console.error(`Error fetching guild member ${user.user_id}:`, err);
                    displayName = `Unknown Member (${user.user_id})`;
                }

                leaderboardEmbed.addFields({
                    name: `#${page * perPage + index + 1} - **${displayName}**`,
                    value: `⭐ XP: **${Math.floor(user.xp)}**`,
                    inline: false
                });
            }

            return leaderboardEmbed;
        };

        const prevButton = new ButtonBuilder()
            .setCustomId("prev_leaderboard")
            .setLabel("◀️ Previous")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 0);

        const nextButton = new ButtonBuilder()
            .setCustomId("next_leaderboard")
            .setLabel("Next ▶️")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === totalPages - 1);

        const row = new ActionRowBuilder().addComponents(prevButton, nextButton);

        const replyMessage = await interaction.editReply({
            embeds: [await generateEmbed(page)],
            components: [row]
        });

        // Collector for pagination
        const collector = replyMessage.createMessageComponentCollector({
            filter: (i) => i.user.id === interaction.user.id,
            time: 60000
        });

        collector.on("collect", async (i) => {
            if (i.customId === "prev_leaderboard" && page > 0) {
                page--;
            } else if (i.customId === "next_leaderboard" && page < totalPages - 1) {
                page++;
            }

            leaderboardData = getLeaderboardPage(page);

            prevButton.setDisabled(page === 0);
            nextButton.setDisabled(page === totalPages - 1);

            await i.update({ embeds: [await generateEmbed(page)], components: [row] });
        });

        collector.on("end", async () => {
            prevButton.setDisabled(true);
            nextButton.setDisabled(true);
            await interaction.editReply({ components: [row] });
        });
    }
});

// Battle Leaderboard
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-battleleaderboard") {
        await interaction.deferReply(); // Prevents timeout while fetching user data

        // Fetch top 10 players sorted by most wins
        const topBattlers = shopDB.prepare(`
            SELECT user_id, wins, losses 
            FROM deathbattle_stats 
            ORDER BY wins DESC 
            LIMIT 10
        `).all() || [];

        // Ensure data exists
        if (!topBattlers.length) {
            return interaction.editReply({ content: "📉 No battle data found!", flags: 64 });
        }

        // Create embed
        const battleEmbed = new EmbedBuilder()
            .setColor("#FF4500")
            .setTitle("⚔️ Death Battle Leaderboard")
            .setDescription("Top 10 users with the most wins in Death Battle")
            .setTimestamp();

        // Fetch user info and add fields to the embed
        for (const [index, user] of topBattlers.entries()) {
            let displayName;
            try {
                const member = await interaction.guild.members.fetch(user.user_id);
                displayName = member ? member.displayName : `Unknown Member (${user.user_id})`;
            } catch (err) {
                console.error(`Error fetching guild member ${user.user_id}:`, err);
                displayName = `Unknown Member (${user.user_id})`;
            }

            battleEmbed.addFields({
                name: `#${index + 1} - **${displayName}**`,
                value: `🏆 Wins: **${user.wins}** | 💀 Losses: **${user.losses}**`,
                inline: false
            });
        }

        // Send leaderboard embed
        await interaction.editReply({ embeds: [battleEmbed] });
    }
});

// Bot Ready

// Run synchronization every 5 minutes
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await synchronizeBans(); // Run the sync on startup
});
setInterval(async () => {
    await synchronizeBans();
}, 5 * 60 * 1000); // 5 minutes

client.once('ready', () => {
    client.user.setActivity({
        type: ActivityType.Custom,
        name: 'The Great Clock',
        state: 'Use /tgc-profile to see your level',
    });
    
    console.log('Bot is ready!');
    console.log(`Available Guilds: ${client.guilds.cache.size}`);

    client.guilds.cache.forEach((guild) => {
        console.log(`Guild: ${guild.name} (ID: ${guild.id})`);
    });

    console.log(`${client.user.tag} is ready!`);
});

// Start Bot
client.login(process.env.TOKEN);
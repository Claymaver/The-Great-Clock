const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder, PermissionFlagsBits,EmbedBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder,StringSelectMenuBuilder,ButtonBuilder,ButtonStyle,ChannelType, PermissionsBitField, ActivityType, Events } = require('discord.js');require('dotenv').config();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildModeration,
            "Guilds"
        ],
    });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Imgur API configuration
const IMGUR_CLIENT_ID = 'ef2b857ff2c5154'; // Replace with your Imgur client ID

// Simple rate limiter for Imgur uploads
const imgurRateLimiter = {
    lastUpload: 0,
    minInterval: 10000, // 10 seconds between uploads
    
    async waitForNextSlot() {
        const now = Date.now();
        const timeSinceLastUpload = now - this.lastUpload;
        
        if (timeSinceLastUpload < this.minInterval) {
            const waitTime = this.minInterval - timeSinceLastUpload;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastUpload = Date.now();
    }
};

// Initialize the REST client
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Initialize Database
const db = new Database('leveling.db', { verbose: console.log }); 
db.exec(`
    CREATE TABLE IF NOT EXISTS user_xp (
        user_id TEXT PRIMARY KEY,
        xp REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS level_up_notifications (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT
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
CREATE TABLE IF NOT EXISTS user_strikes (
    user_id TEXT,
    guild_id TEXT,
    moderator_id TEXT,
    reason TEXT,
    timestamp INTEGER,
    PRIMARY KEY (user_id, guild_id, timestamp)
);
`);
db.exec(`
    CREATE TABLE IF NOT EXISTS disabled_crate_channels (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL
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
    image_url TEXT,
    damage_bonus INTEGER DEFAULT 0,
    health_bonus INTEGER DEFAULT 0,
    crit_chance_bonus REAL DEFAULT 0,
    crit_damage_bonus REAL DEFAULT 0,
    bolt_bonus REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_inventory (
    user_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    is_equipped INTEGER DEFAULT 0,
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
// Add to your initial database setup
shopDB.exec(`
    CREATE TABLE IF NOT EXISTS events (
        name TEXT PRIMARY KEY,
        duration INTEGER,
        active INTEGER DEFAULT 0,
        created_at INTEGER,
        last_updated INTEGER,
        start_date INTEGER,
        end_date INTEGER
    );
`);

// Add connection checking and retry logic
function ensureDatabaseConnection() {
    try {
        db.prepare('SELECT 1').get();
        shopDB.prepare('SELECT 1').get();
    } catch (error) {
        console.error('Database connection error:', error);
        // Implement reconnection logic or graceful shutdown
        process.exit(1);
    }
}

// Check connection periodically
setInterval(ensureDatabaseConnection, 60000); // Every minute

// Add try-catch blocks for database operations
function calculateBoltBonus(userId) {
    try {
        const equippedItems = shopDB.prepare(`
            SELECT SUM(si.bolt_bonus) as total_bonus
            FROM shop_items si
            JOIN user_inventory ui ON si.item_id = ui.item_id
            WHERE ui.user_id = ? AND ui.is_equipped = 1
        `).get(userId);

        return 1 + (equippedItems?.total_bonus || 0);
    } catch (error) {
        console.error('Error calculating bolt bonus:', error);
        return 1; // Return default multiplier on error
    }
}

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
            .setName("setlevelchannel")
            .setDescription("Set the channel where level-up notifications are sent.")
            .addChannelOption(option =>
                option.setName("channel")
                    .setDescription("Select the level-up notification channel.")
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)),

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
        new SlashCommandBuilder()
        .setName("tgc-strike")
        .setDescription("Give a user a strike.")
        .addUserOption(option =>
            option.setName("user")
                .setDescription("User to give a strike to")
                .setRequired(true))
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("Reason for the strike")
                .setRequired(false)),
    
    new SlashCommandBuilder()
        .setName("tgc-checkstrikes")
        .setDescription("Check a user's strikes.")
        .addUserOption(option =>
            option.setName("user")
                .setDescription("User to check")
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName("tgc-removestrike")
        .setDescription("Remove a specific strike from a user.")
        .addUserOption(option =>
            option.setName("user")
                .setDescription("User to remove a strike from")
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName("strike")
                .setDescription("Strike number to remove")
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName("tgc-resetstrikes")
        .setDescription("Reset all strikes for a user.")
        .addUserOption(option =>
            option.setName("user")
                .setDescription("User to reset strikes for")
                .setRequired(true)),

        // ===============================
        // 📩 Message Management Commands
        // ===============================
        new SlashCommandBuilder()
            .setName("tgc-createembed")
            .setDescription("Start creating an embed message."),
        new SlashCommandBuilder()
        .setName("tgc-cancelembed")
        .setDescription("Cancel the current embed creation session."),

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
        new SlashCommandBuilder()
                .setName("tgc-togglecrates")
                .setDescription("Toggle crate spawning in a channel")
                .addChannelOption(option => 
                    option.setName("channel")
                    .setDescription("The channel to toggle crate spawning in")
                    .setRequired(true)),

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
                .setRequired(false))
            .addIntegerOption(option => 
                    option.setName("damage_bonus")
                    .setDescription("Damage bonus for this item")
                    .setRequired(false))
            .addIntegerOption(option => 
                    option.setName("health_bonus")
                    .setDescription("Health bonus for this item")
                    .setRequired(false))
            .addNumberOption(option => 
                    option.setName("crit_chance_bonus")
                    .setDescription("Critical hit chance bonus for this item")
                    .setRequired(false))
            .addNumberOption(option => 
                    option.setName("crit_damage_bonus")
                    .setDescription("Critical hit damage bonus for this item")
                    .setRequired(false))
            .addStringOption(option => 
                option.setName("event")
                    .setDescription("The event this item belongs to (optional)")
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
               .setRequired(true)
                .setAutocomplete(true)),
            
        new SlashCommandBuilder()
        .setName("tgc-equip")
        .setDescription("Equip or unequip an item from your inventory")
        .addStringOption(option =>
            option.setName("item")
                .setDescription("The name of the item to equip/unequip")
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

        new SlashCommandBuilder()
            .setName('tgc-createevent')
            .setDescription('Create a new event')
            .addStringOption(option =>
                option.setName('name')
                    .setDescription('The name of the event')
                    .setRequired(true)),
                
        new SlashCommandBuilder()
            .setName('tgc-startevent')
            .setDescription('Start an existing event')
            .addStringOption(option =>
                option.setName('name')
                    .setDescription('The name of the event')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addIntegerOption(option =>
                option.setName('duration')
                    .setDescription('Override event duration (in days, optional)')
                    .setMinValue(1)
                    .setRequired(false))
            .addChannelOption(option =>
                option.setName('announce-channel')
                    .setDescription('Channel to announce the event start (optional)')
                    .setRequired(false)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
                
        new SlashCommandBuilder()
            .setName('tgc-endevent')
            .setDescription('End an Active event')
            .addStringOption(option =>
                option.setName('name')
                        .setDescription('The name of the event')
                        .setRequired(true)
                        .setAutocomplete(true))
];

// Register Commands
async function registerCommands() {
    if (!process.env.CLIENT_ID) {
        throw new Error('CLIENT_ID is not defined in environment variables');
    }

    if (!commands || !Array.isArray(commands) || commands.length === 0) {
        throw new Error('No commands found to register');
    }

    try {
        console.log('🔄 Starting command registration...');
        
        // Validate each command before registration
        commands.forEach((command, index) => {
            if (!command.name || !command.description) {
                throw new Error(`Invalid command at index ${index}: Missing name or description`);
            }
        });

        // Register commands with Discord API
        const response = await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { 
                body: commands.map(command => command.toJSON()) 
            }
        );

        if (!response) {
            throw new Error('Failed to receive response from Discord API');
        }

        console.log('✅ Commands registered successfully!');
        console.log(`📊 Total commands registered: ${commands.length}`);
        
        // Log individual command names
        commands.forEach(command => {
            console.log(`  • ${command.name}`);
        });

    } catch (error) {
        console.error('❌ Failed to register commands:', error);
        
        // Specific error handling
        if (error.code === 50035) {
            console.error('Invalid command format detected');
        } else if (error.code === 50001) {
            console.error('Bot lacks permissions to register commands');
        }

        // Rethrow error for upstream handling
        throw error;
    }
}

// Execute registration with proper error handling
(async () => {
    try {
        await registerCommands();
    } catch (error) {
        console.error('🚨 Fatal error during command registration:', error);
        // Optionally exit process on fatal error
        // process.exit(1);
    }
})();

// Add cleanup for graceful shutdown
process.on('SIGINT', () => {
    console.log('👋 Received SIGINT. Cleaning up...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('👋 Received SIGTERM. Cleaning up...');
    process.exit(0);
});

client.setMaxListeners(70);
// Optional: Monitor warning events
process.on('warning', (warning) => {
    if (warning.name === 'MaxListenersExceededWarning') {
        console.warn('⚠️ Maximum listeners warning:', warning.message);
    }
});

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
    const userId = targetUser?.id;

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

        // Calculate XP thresholds for current and next level
        let xpForCurrentLevel = calculateTotalXpForLevel(level - 1, baseXp, multiplier);
        let xpForNextLevel = calculateTotalXpForLevel(level, baseXp, multiplier);

        // Calculate XP Progress and Required XP
        const xpProgress = totalXp - xpForCurrentLevel;
        const xpRequired = xpForNextLevel - xpForCurrentLevel;


        // Calculate Progress Bar
        const progressBarLength = 20;
        const progressRatio = Math.max(0, Math.min(1, xpProgress / xpRequired)); // Clamp between 0 and 1
        const progressBarFilled = Math.round(progressRatio * progressBarLength);
        const progressBarEmpty = progressBarLength - progressBarFilled;
        const progressBar = '█'.repeat(progressBarFilled) + '░'.repeat(progressBarEmpty);

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

// Set Level-Up Notification Channel Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "setlevelchannel") return;

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ You do not have permission to set the level-up notification channel.", flags: 64 });
    }

    const channel = interaction.options.getChannel("channel");
    const guildId = interaction.guild.id;

    db.prepare(`
        INSERT INTO level_up_notifications (guild_id, channel_id)
        VALUES (?, ?) 
        ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
    `).run(guildId, channel.id);

    return interaction.reply({
        content: `✅ Level-up notifications will now be sent in ${channel}.`,
        flags: 64
    });
});

 // ===============================
 //    Moderation & Management
 // ===============================

// Calculate total XP required for a specific level
function calculateTotalXpForLevel(level, baseXp, multiplier) {
    if (level <= 0) return 0;
    
    let totalXp = 0;
    for (let i = 1; i <= level; i++) {
        totalXp += Math.ceil(baseXp * Math.pow(multiplier, i - 1));
    }
    return totalXp;
}

async function uploadToImgur(imageUrl) {
    await imgurRateLimiter.waitForNextSlot();
    
    try {
        console.log(`Attempting to upload image to Imgur: ${imageUrl}`);
        
        // Download the image first
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data, 'binary');
        
        // Create form data for Imgur API
        const formData = new FormData();
        formData.append('image', buffer);
        
        // Upload to Imgur
        const response = await axios.post('https://api.imgur.com/3/image', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Client-ID ${IMGUR_CLIENT_ID}`
            }
        });
        
        if (response.data.success) {
            console.log(`Successfully uploaded to Imgur: ${response.data.data.link}`);
            return response.data.data.link;
        } else {
            console.error('Imgur upload failed:', response.data);
            throw new Error('Failed to upload image to Imgur');
        }
    } catch (error) {
        console.error('Error uploading to Imgur:', error.message);
        throw new Error(`Imgur upload failed: ${error.message}`);
    }
}

// Define color constants
const EMBED_COLORS = {
    "Pink": "#eb0062",
    "Red": "#ff0000",
    "Dark Red": "#7c1e1e",
    "Orange": "#ff4800",
    "Yellow": "#ffe500",
    "Green": "#1aff00",
    "Forest Green": "#147839",
    "Light Blue": "#00bdff",
    "Dark Blue": "#356feb",
    "Purple": "#76009a",
    "Default": "#00AE86"
};

// Enum for embed creation steps
const CreationStep = {
    TITLE: 0,
    TITLE_URL: 1,
    DESCRIPTION: 2,
    COLOR: 3,
    THUMBNAIL: 4,
    IMAGE: 5,
    FOOTER: 6,
    BUTTON: 7,
    CHANNEL: 8,
    COMPLETE: 9
};

// Embed Session Manager
class EmbedSession {
    constructor(userId) {
        this.userId = userId;
        this.currentStep = CreationStep.TITLE;
        this.fields = {};
        this.previewMessage = null;
        this.thumbnailAttachment = null;
        this.imageAttachment = null;
    }

    setField(field, value) {
        this.fields[field] = value;
    }

    nextStep() {
        this.currentStep++;
        return this.currentStep;
    }

    handleInput(value) {
        if (value.toLowerCase() === 'skip') {
            if ([CreationStep.TITLE_URL, CreationStep.THUMBNAIL, CreationStep.IMAGE, CreationStep.FOOTER].includes(this.currentStep)) {
                this.nextStep();
                return true;
            }
        }
    }

    isValidImageUrl(url) {
        if (!url || url === 'skip') return false;
        
        // Check if it's a valid URL
        try {
            new URL(url);
        } catch (e) {
            return false;
        }
        
        // Check if it's likely an image URL
        return url.match(/\.(jpeg|jpg|gif|png|webp)$/i) !== null || 
            url.startsWith('https://cdn.discordapp.com/') ||
            url.startsWith('https://media.discordapp.net/') ||
            url.startsWith('https://i.imgur.com/') ||
            url.includes('image');
    }
    getPromptForStep() {
        switch (this.currentStep) {
            case CreationStep.TITLE:
                return "Please enter the embed title:";
            case CreationStep.TITLE_URL:
                return "Please enter the title URL (or type 'skip'):";
            case CreationStep.DESCRIPTION:
                return "Please enter the embed description:";
            case CreationStep.COLOR:
                return `Please choose a color for the embed (${Object.keys(EMBED_COLORS).join(', ')}):`;
            case CreationStep.THUMBNAIL:
                return "Please provide a thumbnail URL, upload an image (will be uploaded to Imgur), or type 'skip':";        
            case CreationStep.IMAGE:
                return "Please provide an image URL, upload an image (will be uploaded to Imgur), or type 'skip':";
            case CreationStep.FOOTER:
                return "Please enter the footer text (or type 'skip'):";
            case CreationStep.BUTTON:
                return "Please provide button text and URL (or type 'skip'):";
            case CreationStep.CHANNEL:
                return "Please select a channel to send the embed:";
            default:
                return "Embed creation complete!";
        }
    }

    toDiscordEmbed() {
        const embed = new EmbedBuilder();
        
        // Set Title and Title URL
        if (this.fields.title) {
            embed.setTitle(this.fields.title);
            if (this.fields.titleUrl && this.fields.titleUrl !== 'skip') {
                embed.setURL(this.fields.titleUrl);
            }
        }
        
        // Set Description
        embed.setDescription(this.fields.description || "Creating embed...");
        
        // Set Color
        if (this.fields.color) {
            embed.setColor(this.fields.color);
        }
        
        // Set Image - prioritize attachment over URL
        if (this.imageAttachment) {
            console.log(`Setting image to attachment: ${this.imageAttachment}`);
            embed.setImage(this.imageAttachment);
        } else if (this.fields.image && this.fields.image !== 'skip') {
            console.log(`Setting image to URL: ${this.fields.image}`);
            embed.setImage(this.fields.image);
        }
        
        // Set Thumbnail - prioritize attachment over URL
        if (this.thumbnailAttachment) {
            console.log(`Setting thumbnail to attachment: ${this.thumbnailAttachment}`);
            embed.setThumbnail(this.thumbnailAttachment);
        } else if (this.fields.thumbnail && this.fields.thumbnail !== 'skip') {
            console.log(`Setting thumbnail to URL: ${this.fields.thumbnail}`);
            embed.setThumbnail(this.fields.thumbnail);
        }
        
        // Set Footer - THIS IS THE FIX
        if (this.fields.footer && this.fields.footer !== 'skip') {
            console.log(`Applying footer text: "${this.fields.footer}"`);
            embed.setFooter({ text: this.fields.footer });
        } else {
            console.log('No footer to apply', this.fields.footer);
        }
    
        return embed;
    }

    getComponents() {
        const components = [];
        if (this.fields.buttonLabel && this.fields.buttonUrl) {
            const button = new ButtonBuilder()
                .setLabel(this.fields.buttonLabel)
                .setURL(this.fields.buttonUrl)
                .setStyle(ButtonStyle.Link);
            components.push(new ActionRowBuilder().addComponents(button));
        }
        return components;
    }

    validateField(field, value) {
        switch (field) {
            case 'title':
                return value.length <= 256;
            case 'titleUrl':
                return value === 'skip' || /^https?:\/\/.+/.test(value);
            case 'description':
                return value.length <= 4096;
            case 'color':
                return EMBED_COLORS[value] !== undefined;
            case 'thumbnail':
                return value === 'skip' || /^https?:\/\/.+/.test(value);
            case 'image':
                return value === 'skip' || /^https?:\/\/.+/.test(value);
            case 'footer':
                return value === 'skip' || value.length <= 2048;
            default:
                return true;
        }
    }
    // Add this to the EmbedSession class
    async uploadAttachmentToImgur(attachment) {
        try {
            // Use the attachment URL
            const imgurUrl = await uploadToImgur(attachment.url);
            return imgurUrl;
        } catch (error) {
            console.error('Failed to upload to Imgur:', error);
            // Return the original URL as fallback
            return attachment.url;
        }
    }
}

class EmbedSessionManager {
    constructor() {
        this.sessions = new Map();
    }

    createSession(userId) {
        const session = new EmbedSession(userId);
        this.sessions.set(userId, session);
        return session;
    }

    getSession(userId) {
        return this.sessions.get(userId);
    }

    deleteSession(userId) {
        this.sessions.delete(userId);
    }
}

// Initialize the session manager
const embedSessionManager = new EmbedSessionManager();

// Command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName !== 'tgc-createembed') return;
    
    try {
        // Check if user already has an active session
        if (embedSessionManager.getSession(interaction.user.id)) {
            return interaction.reply({
                content: '⚠️ You already have an active embed creation session. Please complete or cancel it before starting a new one.',
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

        console.log(`Starting embed creation for user: ${interaction.user.tag} (${interaction.user.id})`);
        
        // Create a new session for this user
        const session = embedSessionManager.createSession(interaction.user.id);
        
        // Send initial prompt as ephemeral
        const embed = new EmbedBuilder()
            .setTitle('Embed Creation Started')
            .setDescription([
                'Let\'s create your embed! I\'ll ask you for each piece of information needed.',
                '',
                '**Instructions:**',
                '• Answer each prompt to build your embed',
                '• Type "skip" to skip optional fields',
                '• Upload images directly or provide URLs',
                '• You\'ll see a live preview as you build',
                '',
                'To cancel at any time, type `/tgc-cancelembed`'
            ].join('\n'))
            .setColor('#00AE86')
            .setFooter({ text: 'Follow the prompts to create your embed' });

        await interaction.reply({ 
            embeds: [embed],
        });
        
        // Send first prompt
        const promptMessage = await interaction.channel.send({
            content: session.getPromptForStep(),
        });
        
        // Create preview message with initial embed
        const previewEmbed = session.toDiscordEmbed();
        console.log('Creating initial preview embed');
        
        try {
            session.previewMessage = await interaction.channel.send({ 
                content: '**Preview:**',
                embeds: [previewEmbed],
            });
            console.log('Preview message created successfully');
        } catch (error) {
            console.error('Error creating preview message:', error);
            await interaction.channel.send('⚠️ There was an issue creating the preview. The embed creation will continue, but you may not see live updates.');
        }
        
        // Add timeout to automatically clean up abandoned sessions
        session.timeoutId = setTimeout(() => {
            if (embedSessionManager.getSession(interaction.user.id)) {
                interaction.channel.send({
                    content: `⚠️ <@${interaction.user.id}> Your embed creation session has timed out due to inactivity.`,
                }).catch(console.error);
                
                embedSessionManager.deleteSession(interaction.user.id);
            }
        }, 15 * 60 * 1000); // 15 minutes timeout
        
    } catch (error) {
        console.error('Error in embed creation command:', error);
        
        // Handle the error gracefully
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: `❌ An error occurred while starting the embed creation: ${error.message}`,
                flags: 64
            });
        } else {
            await interaction.reply({
                content: `❌ An error occurred while starting the embed creation: ${error.message}`,
                flags: 64
            });
        }
        
        // Clean up any created session if there was an error
        if (interaction.user?.id) {
            embedSessionManager.deleteSession(interaction.user.id);
        }
    }
});

// Message handler for embed creation steps
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const session = embedSessionManager.getSession(message.author.id);
    if (!session) return;

    try {
        // Reset session timeout if it exists
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
            
            // Set a new timeout
            session.timeoutId = setTimeout(() => {
                if (embedSessionManager.getSession(message.author.id)) {
                    message.channel.send({
                        content: `⚠️ <@${message.author.id}> Your embed creation session has timed out due to inactivity.`,
                    }).catch(console.error);
                    
                    embedSessionManager.deleteSession(message.author.id);
                }
            }, 15 * 60 * 1000); // 15 minutes timeout
        }

        // Check for cancel command
        if (message.content.toLowerCase() === 'cancel') {
            await message.channel.send('✅ Embed creation cancelled.');
            embedSessionManager.deleteSession(message.author.id);
            return;
        }

        // Process input based on current step
        switch(session.currentStep) {
            case CreationStep.TITLE: {
                if (!message.content.trim()) {
                    await message.channel.send("❌ Title cannot be empty. Please enter a title for your embed:");
                    return;
                }
                
                if (message.content.length > 256) {
                    await message.channel.send("❌ Title is too long (max 256 characters). Please enter a shorter title:");
                    return;
                }
                
                session.setField('title', message.content);
                break;
            }
            case CreationStep.TITLE_URL: {
                if (message.content.toLowerCase() !== 'skip' && !message.content.match(/^https?:\/\/.+/)) {
                    await message.channel.send("❌ Invalid URL format. Please enter a valid URL starting with http:// or https:// (or type 'skip'):");
                    return;
                }
                
                session.setField('titleUrl', message.content);
                break;
            }
            case CreationStep.DESCRIPTION: {
                if (!message.content.trim()) {
                    await message.channel.send("❌ Description cannot be empty. Please enter a description for your embed:");
                    return;
                }
                
                if (message.content.length > 4096) {
                    await message.channel.send("❌ Description is too long (max 4096 characters). Please enter a shorter description:");
                    return;
                }
                
                session.setField('description', message.content);
                break;
            }
            case CreationStep.COLOR: {
            if (message.content.toLowerCase() === 'skip') {
                // Default color if skipped
                session.setField('color', EMBED_COLORS["Default"]);
            } else {
                // Check if the color exists in the EMBED_COLORS object (case-insensitive)
                const colorInput = message.content;
                const colorKey = Object.keys(EMBED_COLORS).find(key => 
                    key.toLowerCase() === colorInput.toLowerCase()
                );
                
                if (colorKey) {
                    session.setField('color', EMBED_COLORS[colorKey]);
                } else {
                    // If color doesn't exist, send available colors and return
                    const availableColors = Object.keys(EMBED_COLORS).join(', ');
                    await message.channel.send(`❌ Invalid color. Please choose from: ${availableColors} (or type 'skip' for default):`);
                    return;
                }
            }
            break;
        }
            case CreationStep.THUMBNAIL: {
                // Check for image attachment first
                if (message.attachments.size > 0) {
                    const attachment = message.attachments.first();
                    if (attachment.contentType?.startsWith('image/') || 
                        attachment.name?.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
                        
                        await message.channel.send("🔄 Uploading thumbnail to Imgur...");
                        
                        try {
                            // Upload to Imgur
                            const imgurUrl = await session.uploadAttachmentToImgur(attachment);
                            console.log(`Setting thumbnail to Imgur URL: ${imgurUrl}`);
                            session.thumbnailAttachment = imgurUrl;
                            
                            await message.channel.send("✅ Thumbnail uploaded successfully!");
                        } catch (error) {
                            console.error('Thumbnail upload error:', error);
                            await message.channel.send("⚠️ Failed to upload to Imgur. Using direct attachment URL instead.");
                            session.thumbnailAttachment = attachment.url;
                        }
                    } else {
                        await message.channel.send("❌ The uploaded file is not an image. Please upload an image, provide a URL, or type 'skip':");
                        return;
                    }
                } else if (message.content.toLowerCase() !== 'skip') {
                    // Try to use the URL directly
                    console.log(`Setting thumbnail URL: ${message.content}`);
                    session.setField('thumbnail', message.content);
                } else {
                    console.log('Thumbnail step skipped');
                }
                break;
            }

            case CreationStep.IMAGE: {
                // Check for image attachment first
                if (message.attachments.size > 0) {
                    const attachment = message.attachments.first();
                    if (attachment.contentType?.startsWith('image/') || 
                        attachment.name?.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
                        
                        await message.channel.send("🔄 Uploading image to Imgur...");
                        
                        try {
                            // Upload to Imgur
                            const imgurUrl = await session.uploadAttachmentToImgur(attachment);
                            console.log(`Setting image to Imgur URL: ${imgurUrl}`);
                            session.imageAttachment = imgurUrl;
                            
                            await message.channel.send("✅ Image uploaded successfully!");
                        } catch (error) {
                            console.error('Image upload error:', error);
                            await message.channel.send("⚠️ Failed to upload to Imgur. Using direct attachment URL instead.");
                            session.imageAttachment = attachment.url;
                        }
                    } else {
                        await message.channel.send("❌ The uploaded file is not an image. Please upload an image, provide a URL, or type 'skip':");
                        return;
                    }
                } else if (message.content.toLowerCase() !== 'skip') {
                    if (!session.isValidImageUrl(message.content)) {
                        await message.channel.send("❌ Invalid image URL. Please provide a valid image URL, upload an image, or type 'skip':");
                        return;
                    }
                    
                    console.log(`Setting image URL: ${message.content}`);
                    session.setField('image', message.content);
                } else {
                    console.log('Image step skipped');
                }
                break;
            }
            case CreationStep.FOOTER: {
                if (message.content.toLowerCase() !== 'skip') {
                    console.log(`Setting footer text: "${message.content}"`);
                    session.setField('footer', message.content);
                } else {
                    console.log('Footer step skipped');
                }
                break;
            }
            case CreationStep.BUTTON: {
                if (message.content.toLowerCase() !== 'skip') {
                    const parts = message.content.split(' ');
                    if (parts.length < 2) {
                        await message.channel.send("❌ Invalid button format. Please use format: \"Label URL\" or type 'skip':");
                        return;
                    }
                    const label = parts[0];
                    const url = parts.slice(1).join(' ');
                    
                    if (!label || !url || !url.match(/^https?:\/\/.+/)) {
                        await message.channel.send("❌ Invalid button format. URL must start with http:// or https://. Please try again or type 'skip':");
                        return;
                    }
                    
                    if (label.length > 80) {
                        await message.channel.send("❌ Button label is too long (max 80 characters). Please use a shorter label:");
                        return;
                    }
                    
                    session.setField('buttonLabel', label);
                    session.setField('buttonUrl', url);
                }
                break;
            }
            case CreationStep.CHANNEL: {
                const channel = message.mentions.channels.first();
                if (!channel) {
                    await message.channel.send('❌ Please mention a valid channel (#channel-name):');
                    return;
                }

                // Check permissions in the target channel
                const permissions = channel.permissionsFor(message.client.user);
                if (!permissions.has(PermissionsBitField.Flags.SendMessages) || 
                    !permissions.has(PermissionsBitField.Flags.EmbedLinks)) {
                    await message.channel.send(`❌ I don't have permission to send embeds in ${channel}. Please choose another channel or fix permissions.`);
                    return;
                }

                // Send the final embed
                console.log('Creating final embed with:', {
                    title: session.fields.title,
                    description: session.fields.description,
                    thumbnail: session.thumbnailAttachment || session.fields.thumbnail,
                    image: session.imageAttachment || session.fields.image
                });
                
                const finalEmbed = session.toDiscordEmbed();
                const components = session.getComponents();
                
                try {
                    const sentEmbed = await channel.send({ embeds: [finalEmbed], components });
                    console.log('Embed sent successfully');
                    
                    // Send confirmation with link to the embed
                    await message.channel.send({
                        content: `✅ Embed created and sent successfully to ${channel}!\n[Jump to Embed](${sentEmbed.url})`,
                    });
                } catch (error) {
                    console.error('Error sending embed:', error);
                    await message.channel.send(`❌ Error sending embed: ${error.message}`);
                    return;
                }

                try {
                    // Collect all messages to delete
                    const messagesToDelete = [];
                    
                    // Get the last 50 messages in the channel
                    const messages = await message.channel.messages.fetch({ limit: 50 });
                    
                    // Filter messages that are part of this embed creation session
                    const sessionMessages = messages.filter(msg => 
                        (msg.author.id === message.client.user.id && 
                         msg.content.includes('Please') && 
                         msg.createdTimestamp > Date.now() - 30 * 60 * 1000) || // Only from last 30 minutes
                        (msg.author.id === message.author.id && 
                         msg.createdTimestamp > Date.now() - 30 * 60 * 1000)    // Only from last 30 minutes
                    );
                    
                    // Add session preview message if it exists
                    if (session.previewMessage) {
                        messagesToDelete.push(session.previewMessage);
                    }
                    
                    // Delete all collected messages
                    if (sessionMessages.size > 0) {
                        await message.channel.bulkDelete(sessionMessages).catch(error => {
                            console.error('Error bulk deleting messages:', error);
                        });
                    }
                } catch (error) {
                    console.error('Error cleaning up messages:', error);
                    // Continue with session cleanup even if message cleanup fails
                }

                // Clear the timeout
                if (session.timeoutId) {
                    clearTimeout(session.timeoutId);
                }
                
                // Delete the session
                embedSessionManager.deleteSession(message.author.id);
                return;
            }
        }

        // Delete user's input message
        await message.delete().catch(error => {
            console.error('Error deleting user message:', error);
            // Continue even if we can't delete the message
        });

        // Update preview
        try {
            console.log('Updating preview with:', {
                title: session.fields.title,
                description: session.fields.description,
                thumbnail: session.thumbnailAttachment || session.fields.thumbnail,
                image: session.imageAttachment || session.fields.image
            });
            
            const previewEmbed = session.toDiscordEmbed();
            if (session.previewMessage) {
                await session.previewMessage.edit({ 
                    content: '**Preview:**',
                    embeds: [previewEmbed] 
                });
            }
        } catch (error) {
            console.error('Error updating preview:', error);
            if (error.message.includes('Invalid image')) {
                await message.channel.send('⚠️ The image URL provided is invalid or inaccessible. Please try a different URL or upload an image directly.');
            } else {
                await message.channel.send(`⚠️ There was an error updating the preview: ${error.message}`);
            }
        }

        // Move to next step
        session.nextStep();
        const nextPrompt = session.getPromptForStep();
        if (nextPrompt) {
            await message.channel.send(nextPrompt);
        }

    } catch (error) {
        console.error('Embed creation error:', error);
        await message.channel.send(`❌ There was an error processing your input: ${error.message}`);
        
        // Don't delete the session on error, let the user try again
    }
});

// cancel embed creation command handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName !== 'tgc-cancelembed') return;
    
    // Check if user has an active session
    const session = embedSessionManager.getSession(interaction.user.id);
    
    if (!session) {
        return interaction.reply({
            content: '❌ You don\'t have an active embed creation session.',
            flags: 64
        });
    }
    
    try {
        // Clean up any preview messages
        if (session.previewMessage) {
            await session.previewMessage.delete().catch(console.error);
        }
        
        // Clear any timeouts
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
        }
        
        // Delete the session
        embedSessionManager.deleteSession(interaction.user.id);
        
        await interaction.reply({
            content: '✅ Embed creation session cancelled successfully.',
            flags: 64
        });
        
    } catch (error) {
        console.error('Error cancelling embed session:', error);
        await interaction.reply({
            content: `❌ An error occurred while cancelling the embed session: ${error.message}`,
            flags: 64
        });
    }
});

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', console.error);

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

        // Defer the reply to give us more time to process
        await interaction.deferReply();

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
            return interaction.editReply({ content: "❌ Database error while storing the ban." });
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

        // Use editReply instead of reply since we deferred earlier
        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error("❌ Error executing global ban:", error);
        
        // If we haven't replied yet, reply now
        if (interaction.deferred) {
            await interaction.editReply({ content: "An error occurred while executing the ban." });
        } else {
            await interaction.reply({ content: "An error occurred while executing the ban.", flags: 64 });
        }
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

// unban autocomplete handler
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

// Handle /tgc-strike command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-strike") return;

    // Check if the user has mod permissions
    if (!interaction.member.permissions.has("KickMembers")) {
        return interaction.reply({
            content: "❌ You need **Kick Members** permission to issue strikes.",
            flags: 64
        });
    }

    const target = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason") || "No reason provided";

    if (!target) {
        return interaction.reply({
            content: "❌ You must specify a user to strike.",
            flags: 64
        });
    }

    // Store strike in database
    const timestamp = Date.now();
    db.prepare(`
        INSERT INTO user_strikes (user_id, guild_id, moderator_id, reason, timestamp)
        VALUES (?, ?, ?, ?, ?)
    `).run(target.id, interaction.guild.id, interaction.user.id, reason, timestamp);

    // Count total strikes for the user
    const strikes = db.prepare(`
        SELECT COUNT(*) AS count FROM user_strikes 
        WHERE user_id = ? AND guild_id = ?
    `).get(target.id, interaction.guild.id).count;

    // Check if user should be banned (3 strikes)
    if (strikes >= 3) {
        try {
            // Send ban notification to user before banning
            const banEmbed = new EmbedBuilder()
                .setTitle("🚫 You Have Been Banned")
                .setDescription(`You have been banned from all TGC Network servers.`)
                .addFields(
                    { name: "Reason", value: "Reached 3 strikes" },
                    { name: "Final Strike Reason", value: reason }
                )
                .setColor("#FF0000")
                .setTimestamp();

            try {
                await target.send({ embeds: [banEmbed] });
            } catch (err) {
                console.log(`⚠️ Could not DM ${target.tag} about their ban.`);
            }

            // Get all guilds where the bot is present
            const guilds = client.guilds.cache;

            // Ban user from all guilds
            for (const [guildId, guild] of guilds) {
                try {
                    await guild.members.ban(target.id, {
                        reason: `Global Ban - Reached 3 strikes. Last strike reason: ${reason}`
                    });
                    console.log(`Banned ${target.tag} from ${guild.name}`);
                } catch (err) {
                    console.log(`Failed to ban ${target.tag} from ${guild.name}: ${err.message}`);
                }
            }

            // Clear strikes from database
            db.prepare(`
                DELETE FROM user_strikes WHERE user_id = ? AND guild_id = ?
            `).run(target.id, interaction.guild.id);

            // Create ban notification embed for server
            const serverBanEmbed = new EmbedBuilder()
                .setTitle("🚨 Global Ban Executed")
                .setDescription(`**${target.tag}** has been globally banned for reaching 3 strikes.`)
                .addFields(
                    { name: "Final Strike Reason", value: reason },
                )
                .setColor("#FF0000")
                .setTimestamp();

            await interaction.reply({ embeds: [serverBanEmbed] });

            // Log the ban in the logging channel if it exists
            const loggingChannelId = db.prepare('SELECT logging_channel FROM guild_settings WHERE guild_id = ?')
                .get(interaction.guild.id)?.logging_channel;

            if (loggingChannelId) {
                const loggingChannel = await interaction.guild.channels.fetch(loggingChannelId);
                if (loggingChannel) {
                    await loggingChannel.send({ embeds: [serverBanEmbed] });
                }
            }

            return;
        } catch (error) {
            console.error("Error executing global ban:", error);
            return interaction.reply({
                content: "❌ Failed to execute global ban. Check bot permissions.",
                flags: 64
            });
        }
    } else {
        // If not banned (less than 3 strikes), send strike notification
        const strikeEmbed = new EmbedBuilder()
            .setTitle("⚠️ You Received a Strike")
            .setDescription(`You have been given a strike in **${interaction.guild.name}**.`)
            .addFields(
                { name: "Reason", value: reason, inline: true },
                { name: "Total Strikes", value: `${strikes}/3`, inline: true }
            )
            .setColor("#FFA500")
            .setTimestamp();

        try {
            await target.send({ embeds: [strikeEmbed] });
        } catch (err) {
            console.log(`⚠️ Could not DM ${target.tag} about their strike.`);
        }

        return interaction.reply({
            content: `✅ **${target.tag}** has been given a **strike**.\nCurrent strikes: **${strikes}/3**.`,
            ephemeral: false
        });
    }
});

// Check Strikes Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-checkstrikes") return;

    if (!interaction.member.permissions.has("KickMembers")) {
        return interaction.reply({
            content: "❌ You need **Kick Members** permission to check strikes.",
            flags: 64
        });
    }

    const target = interaction.options.getUser("user");

    const strikes = db.prepare(`
        SELECT * FROM user_strikes WHERE user_id = ? AND guild_id = ?
    `).all(target.id, interaction.guild.id);

    if (strikes.length === 0) {
        return interaction.reply({
            content: `✅ **${target.tag}** has no strikes.`,
            flags: 64
        });
    }

    const embed = new EmbedBuilder()
        .setTitle(`⚠️ Strikes for ${target.tag}`)
        .setColor("#FFA500")
        .setDescription(strikes.map((s, i) => `**${i + 1}.** ${s.reason} - <t:${Math.floor(s.timestamp / 1000)}:F>`).join("\n"))
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
});

// Remove Strike Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-removestrike") return;

    if (!interaction.member.permissions.has("KickMembers")) {
        return interaction.reply({
            content: "❌ You need **Kick Members** permission to remove a strike.",
            flags: 64
        });
    }

    const target = interaction.options.getUser("user");
    const strikeIndex = interaction.options.getInteger("strike");

    const strikes = db.prepare(`
        SELECT rowid, * FROM user_strikes WHERE user_id = ? AND guild_id = ?
    `).all(target.id, interaction.guild.id);

    if (strikes.length === 0) {
        return interaction.reply({
            content: `✅ **${target.tag}** has no strikes.`,
            flags: 64
        });
    }

    if (strikeIndex < 1 || strikeIndex > strikes.length) {
        return interaction.reply({
            content: "❌ Invalid strike number.",
            flags: 64
        });
    }

    const strikeToRemove = strikes[strikeIndex - 1];

    db.prepare(`
        DELETE FROM user_strikes WHERE rowid = ?
    `).run(strikeToRemove.rowid);

    return interaction.reply({
        content: `✅ Removed **strike #${strikeIndex}** from **${target.tag}**.`,
        ephemeral: false
    });
});

// Reset Strikes Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-resetstrikes") return;

    if (!interaction.member.permissions.has("KickMembers")) {
        return interaction.reply({
            content: "❌ You need **Kick Members** permission to reset strikes.",
            flags: 64
        });
    }

    const target = interaction.options.getUser("user");

    db.prepare(`
        DELETE FROM user_strikes WHERE user_id = ? AND guild_id = ?
    `).run(target.id, interaction.guild.id);

    return interaction.reply({
        content: `✅ **${target.tag}**'s strikes have been reset.`,
        ephemeral: false
    });
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
            { 
                label: 'Support', 
                value: 'support', 
                description: 'General support ticket',
                emoji: '❓'
            },
            { 
                label: 'Report', 
                value: 'report', 
                description: 'Report a user or issue',
                emoji: '🚨'
            },
            { 
                label: 'Moderator Application', 
                value: 'modapp', 
                description: 'Apply for a moderator position',
                emoji: '👮'
            }
        ]);

    // Create embed for ticket selection
    const ticketEmbed = new EmbedBuilder()
        .setTitle('🎫 Create a Ticket')
        .setDescription([
            'Please select the type of ticket you would like to create:',
            '',
            '❓ **Support** - General help and support',
            '🚨 **Report** - Report a user or issue',
            '👮 **Moderator Application** - Apply to become a moderator'
        ].join('\n'))
        .setColor('#2F3136')
        .setFooter({ text: 'Select an option below to continue' });

    const row = new ActionRowBuilder().addComponents(typeMenu);

    await interaction.reply({
        embeds: [ticketEmbed],
        components: [row],
        flags: 64
    });

    // Create collector for menu interaction
    const filter = i => i.user.id === interaction.user.id;
    const collector = interaction.channel.createMessageComponentCollector({ 
        filter, 
        time: 30000,
        max: 1
    });

    collector.on('end', collected => {
        if (collected.size === 0) {
            interaction.editReply({
                content: '⏰ Ticket creation timed out. Please try again.',
                components: [],
                embeds: [],
                flags: 64
            });
        }
    });
});

// Handle ticket type selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'selectTicketType') return;

    const selectedType = interaction.values[0];

    try {
        switch (selectedType) {
            case 'report':
                // Show report categories
                const reportCategories = new StringSelectMenuBuilder()
                    .setCustomId('selectReportCategory')
                    .setPlaceholder('Select a category for your report')
                    .addOptions([
                        { label: 'Harassment', value: 'harassment', emoji: '😠' },
                        { label: 'Spam', value: 'spam', emoji: '🔨' },
                        { label: 'Scam', value: 'scam', emoji: '💸' },
                        { label: 'Other', value: 'other', emoji: '❓' },
                    ]);

                const reportEmbed = new EmbedBuilder()
                    .setTitle('🚨 Create a Report')
                    .setDescription('Please select the category that best matches your report:')
                    .setColor('#FF0000');

                await interaction.update({
                    embeds: [reportEmbed],
                    components: [new ActionRowBuilder().addComponents(reportCategories)],
                    flags: 64
                });
                break;

            case 'modapp':
                // Create mod application channel
                const channel = await createTicketChannel(interaction, 'modapp');
                if (channel) {
                    await interaction.update({
                        content: `✅ Application channel created: ${channel}`,
                        components: [],
                        embeds: [],
                        flags: 64
                    });
                }
                break;

            case 'support':
                // Create support ticket channel
                const supportChannel = await createTicketChannel(interaction, 'support');
                if (supportChannel) {
                    await interaction.update({
                        content: `✅ Support ticket created: ${supportChannel}`,
                        components: [],
                        embeds: [],
                        flags: 64
                    });
                }
                break;
        }
    } catch (error) {
        console.error('Error handling ticket type selection:', error);
        await interaction.update({
            content: '❌ An error occurred while creating your ticket. Please try again.',
            components: [],
            embeds: [],
            flags: 64
        });
    }
});

// Handle report category selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    if (interaction.customId === 'selectReportCategory') {
        const selectedCategory = interaction.values[0];
        await createTicketChannel(interaction, 'report', selectedCategory);
    }
});

// Application questions array
const applicationQuestions = [
    "What is your age?",
    "What timezone are you in?",
    "Do you have any previous moderation experience? If yes, please describe.",
    "Why do you want to become a moderator?",
    "How would you handle a situation where two users are arguing?",
    "What do you think are the most important qualities of a moderator?",
    "Have you read and do you understand our server rules?",
    "are there any changes you would like to see happen in the server?",
    "Is there anything else you'd like to add to your application?"
];

// Create a ticket channel
async function createTicketChannel(interaction, selectedType, selectedCategory = null) {
    const guild = interaction.guild;
    const user = interaction.user;
    const botId = interaction.client.user.id;
    const categoryName = selectedCategory ? `Report-${selectedCategory}` : selectedType;
    const channelName = `${categoryName}-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

    try {
        const allRoles = await getAllGuildRoles(guild.id); // Added await
        const permissionOverwrites = [
            {
                id: guild.id,
                deny: [PermissionsBitField.Flags.ViewChannel]
            },
            {
                id: user.id,
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            },
            {
                id: botId,
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels]
            }
        ];

        for (const roleId of allRoles) {
            permissionOverwrites.push({
                id: roleId,
                allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
            });
        }

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            permissionOverwrites
        });

        await interaction.reply({
            content: `✅ Ticket created: ${channel}`,
            flags: 64 
        });

        if (selectedType === 'modapp') {
            channel.applicationData = {
                userId: user.id,
                answers: [],
                currentQuestion: 0
            };

            const welcomeEmbed = new EmbedBuilder()
                .setTitle("👮 Moderator Application")
                .setDescription([
                    `Welcome ${user}! You're about to start your moderator application.`,
                    "",
                    "📝 You will be asked a series of questions.",
                    "⏰ Please answer each question thoroughly.",
                    "❌ Type 'cancel' at any time to cancel the application.",
                    "",
                    "**Are you ready to begin? Type __yes__ to start!**"
                ].join('\n'))
                .setColor("#2F3136")
                .setTimestamp();

            await channel.send({ embeds: [welcomeEmbed] });

            const collector = channel.createMessageCollector({ 
                filter: m => m.author.id === user.id,
                time: 300000
            });

            // Removed duplicate 'end' event listener
            collector.on('collect', async (message) => {
                if (message.content.toLowerCase() === 'yes') {
                    collector.stop('ready');
                    await askQuestion(channel, user, 0);
                } else if (message.content.toLowerCase() === 'cancel') {
                    collector.stop('cancelled');
                    await channel.send("❌ Application cancelled.");
                }
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time') {
                    channel.send("⏰ Application timed out. Please start a new application.");
                }
            });

        } else {
            const ticketEmbed = new EmbedBuilder()
                .setTitle(selectedType === 'report' ? "🚨 Report Ticket" : "❓ Support Ticket")
                .setDescription([
                    `Welcome ${user}!`,
                    "",
                    selectedType === 'report' 
                        ? `Please provide details about your report regarding **${selectedCategory}**:`
                        : "Please describe your issue in detail:",
                    "",
                    "A staff member will assist you shortly."
                ].join('\n'))
                .setColor(selectedType === 'report' ? "#FF0000" : "#00FF00")
                .setTimestamp();

            await channel.send({ embeds: [ticketEmbed] });
        }

        return channel;

    } catch (error) {
        console.error("❌ Error creating ticket channel:", error);
        await interaction.reply({
            content: "❌ There was an error creating your ticket. Please try again later.",
            flags: 64
        });
    }
}

// Function to ask application questions
async function askQuestion(channel, user, questionIndex) {
    if (questionIndex >= applicationQuestions.length) {
        await createApplicationSummary(channel, user);
        return;
    }

    const questionEmbed = new EmbedBuilder()
        .setTitle(`Question ${questionIndex + 1}/${applicationQuestions.length}`)
        .setDescription(applicationQuestions[questionIndex])
        .setColor("#2F3136")
        .setFooter({ text: "Type your answer below | Type 'cancel' to stop" });

    await channel.send({ embeds: [questionEmbed] });

    const collector = channel.createMessageCollector({ 
        filter: m => m.author.id === user.id, // Fixed: user.Id to user.id
        time: 300000
    });

    // Removed duplicate 'end' event listener

    collector.on('collect', async (message) => {
        if (message.content.toLowerCase() === 'cancel') {
            collector.stop('cancelled');
            return;
        }

        // Added null check for applicationData
        if (!channel.applicationData) {
            channel.applicationData = { answers: [] };
        }
        
        channel.applicationData.answers[questionIndex] = message.content;
        collector.stop('answered');
        await askQuestion(channel, user, questionIndex + 1);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'cancelled') {
            channel.send("❌ Application cancelled.");
        } else if (reason === 'time') {
            channel.send("⏰ Question timed out. Please start a new application.");
        }
    });
}

// Function to create application summary
async function createApplicationSummary(channel, user) {
    const answers = channel.applicationData.answers;
    const summaryEmbed = new EmbedBuilder()
        .setTitle("📝 Moderator Application Summary")
        .setDescription(`Application submitted by ${user.tag}`)
        .setColor("#2F3136")
        .setTimestamp();

    // Add Q&A fields
    applicationQuestions.forEach((question, index) => {
        summaryEmbed.addFields({
            name: `Q${index + 1}: ${question}`,
            value: answers[index] || "No answer provided",
            inline: false
        });
    });

    // Add user info
    summaryEmbed.addFields(
        { name: '👤 User ID', value: user.id, inline: true },
        { name: '📅 Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true }
    );

    // Create response buttons
    const buttons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`approve_app_${user.id}`)
                .setLabel('✅ Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`deny_app_${user.id}`)
                .setLabel('❌ Deny')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`interview_app_${user.id}`)
                .setLabel('🗣️ Schedule Interview')
                .setStyle(ButtonStyle.Primary)
        );

    await channel.send({
        content: "✅ Application completed! Staff will review your submission.",
        embeds: [summaryEmbed],
        components: [buttons]
    });
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
            content: '❌ You do not have permission to use this command.',
            flags: 64
        });
    }

    const guildId = interaction.guild?.id;
    const channel = interaction.channel;
    const user = interaction.user;

    if (!guildId) {
        return interaction.reply({
            content: '❌ This command can only be used in a server.',
            flags: 64,
        });
    }

    try {
        // Fetch the log channel from the database
        console.log(`Fetching log channel for guild: ${guildId}`);
        const result = db.prepare('SELECT log_channel FROM guild_settings WHERE guild_id = ?').get(guildId);

        if (!result || !result.log_channel) {
            return interaction.reply({
                content: '❌ No log channel is set. Use `/tgc-setlogchannel` to set it.',
                flags: 64,
            });
        }

        const logChannelId = result.log_channel;
        const logChannel = interaction.guild.channels.cache.get(logChannelId);
        
        if (!logChannel) {
            return interaction.reply({
                content: '❌ The configured log channel is invalid or inaccessible. Please set it again.',
                flags: 64,
            });
        }

        // Check if this is a moderator application channel
        const isModApp = channel.name.startsWith('modapp-');

        // Fetch messages from the ticket channel
        const messages = await channel.messages.fetch({ limit: 100 });
        
        // Create transcript
        let transcript = '';
        const messageArray = Array.from(messages.values()).reverse();

        // Format transcript based on ticket type
        if (isModApp) {
            // Format moderator application transcript
            transcript = formatModApplicationTranscript(messageArray);
        } else {
            // Format regular ticket transcript
            transcript = messageArray
                .map(msg => {
                    const timestamp = new Date(msg.createdTimestamp).toLocaleString();
                    const content = msg.content || '[No Text Content]';
                    const attachments = msg.attachments.size ? 
                        '\nAttachments: ' + Array.from(msg.attachments.values())
                            .map(att => att.url)
                            .join(', ') : '';
                    const embeds = msg.embeds.length ? 
                        '\nEmbeds: ' + msg.embeds.length + ' embed(s)' : '';
                    
                    return `[${timestamp}] ${msg.author.tag}:\n${content}${attachments}${embeds}\n`;
                })
                .join('\n');
        }

        // Save transcript to a file
        const fs = require('fs');
        const path = require('path');
        const logFolder = path.join(__dirname, 'ticket_logs');
        if (!fs.existsSync(logFolder)) fs.mkdirSync(logFolder);

        const transcriptPath = path.join(logFolder, `ticket-${channel.id}.txt`);
        fs.writeFileSync(transcriptPath, transcript);

        // Create log embed
        const logEmbed = new EmbedBuilder()
            .setTitle(isModApp ? '📝 Moderator Application Closed' : '🎫 Ticket Closed')
            .setColor(isModApp ? '#9B59B6' : '#2F3136')
            .addFields(
                { name: '👤 Closed By', value: user.tag, inline: true },
                { name: '📌 Channel', value: channel.name, inline: true },
                { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
            )
            .setFooter({ text: `ID: ${channel.id}` })
            .setTimestamp();

        // Send the log
        await logChannel.send({
            embeds: [logEmbed],
            files: [transcriptPath],
        });

        // Notify the user before closing
        await interaction.reply({
            content: '✅ Closing ticket and saving transcript...',
            flags: 64,
        });

        // Delete the ticket channel after a short delay
        setTimeout(async () => {
            await channel.delete();
        }, 2000);

    } catch (error) {
        console.error('Error closing ticket:', error);
        return interaction.reply({
            content: '❌ An error occurred while closing the ticket. Please try again later.',
            flags: 64,
        });
    }
});

// Handle application approval
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

// Handle approval button
if (interaction.customId.startsWith('approve_app_')) {
    // Check permissions
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: '❌ You do not have permission to approve applications.',
            flags: 64
        });
    }

    const applicantId = interaction.customId.split('_')[2];
    try {
        const applicant = await interaction.guild.members.fetch(applicantId);
        
        // Create approval embed
        const approvalEmbed = new EmbedBuilder()
            .setTitle("✅ Application Approved")
            .setDescription([
                `Congratulations ${applicant}! Your moderator application has been approved.`,
                "",
                "A staff member will contact you soon with further information.",
                "Thank you for your interest in helping our community!"
            ].join('\n'))
            .setColor("#00FF00")
            .setTimestamp();

        // Send DM to applicant
        try {
            await applicant.send({ embeds: [approvalEmbed] });
        } catch (error) {
            console.error("Could not DM applicant:", error);
        }

        // Get log channel
        const logChannelId = db.prepare('SELECT log_channel FROM guild_settings WHERE guild_id = ?')
            .get(interaction.guild.id)?.log_channel;

        if (logChannelId) {
            const logChannel = await interaction.guild.channels.fetch(logChannelId);
            if (logChannel) {
                await logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("📝 Moderator Application Approved")
                            .setDescription([
                                `**Applicant:** ${applicant.user.tag}`,
                                `**Approved by:** ${interaction.user.tag}`,
                                `**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`
                            ].join('\n'))
                            .setColor("#00FF00")
                    ]
                });
            }
        }
        // Acknowledge the interaction before deleting the channel
        await interaction.reply({
            content: "✅ Application approved. This channel will be deleted in 5 seconds.",
            flags: 64
        });

        // Delete the channel after a short delay
        setTimeout(async () => {
            await interaction.channel.delete()
                .catch(error => console.error("Error deleting channel:", error));
        }, 5000);

    } catch (error) {
        console.error("Error handling application approval:", error);
        await interaction.reply({
            content: "❌ An error occurred while processing the approval.",
            flags: 64
        });
    }
}
});

// Handle deny button
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith('deny_app_')) return;

    // Check permissions
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: '❌ You do not have permission to deny applications.',
            flags: 64
        });
    }

    const applicantId = interaction.customId.split('_')[2];

    // Create modal for denial reason
    const modal = new ModalBuilder()
        .setCustomId(`deny_reason_${applicantId}`)
        .setTitle('Application Denial');

    const reasonInput = new TextInputBuilder()
        .setCustomId('denial_reason')
        .setLabel('Why are you denying this application?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Enter the reason for denial...')
        .setRequired(true);

    const actionRow = new ActionRowBuilder().addComponents(reasonInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
});

// Handle denial reason modal submission
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith('deny_reason_')) return;

    const applicantId = interaction.customId.split('_')[2];
    const reason = interaction.fields.getTextInputValue('denial_reason');

    try {
        const applicant = await interaction.guild.members.fetch(applicantId);
        
        // Create denial embed
        const denialEmbed = new EmbedBuilder()
            .setTitle("❌ Application Denied")
            .setDescription([
                `Hello ${applicant}, your moderator application has been denied.`,
                "",
                "**Reason:**",
                reason,
                "",
                "Thank you for your interest in our community."
            ].join('\n'))
            .setColor("#FF0000")
            .setTimestamp();

        // Send DM to applicant
        try {
            await applicant.send({ embeds: [denialEmbed] });
        } catch (error) {
            console.error("Could not DM applicant:", error);
        }

        // Get log channel
        const logChannelId = db.prepare('SELECT log_channel FROM guild_settings WHERE guild_id = ?')
            .get(interaction.guild.id)?.log_channel;

        if (logChannelId) {
            const logChannel = await interaction.guild.channels.fetch(logChannelId);
            if (logChannel) {
                await logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("📝 Moderator Application Denied")
                            .setDescription([
                                `**Applicant:** ${applicant.user.tag}`,
                                `**Denied by:** ${interaction.user.tag}`,
                                `**Reason:** ${reason}`,
                                `**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`
                            ].join('\n'))
                            .setColor("#FF0000")
                    ]
                });
            }
        }

        // Acknowledge the interaction before deleting the channel
        await interaction.reply({
            content: "❌ Application denied. This channel will be deleted in 5 seconds.",
            flags: 64
        });

        // Delete the channel after a short delay
        setTimeout(async () => {
            await interaction.channel.delete()
                .catch(error => console.error("Error deleting channel:", error));
        }, 5000);

    } catch (error) {
        console.error("Error handling application denial:", error);
        await interaction.reply({
            content: "❌ An error occurred while processing the denial.",
            flags: 64
        });
    }
});

// Handle interview button
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith('interview_app_')) return;

    // Check permissions
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: '❌ You do not have permission to schedule interviews.',
            flags: 64
        });
    }

    const applicantId = interaction.customId.split('_')[2];

    // Create modal for interview scheduling
    const modal = new ModalBuilder()
        .setCustomId(`schedule_interview_${applicantId}`)
        .setTitle('Schedule Interview');

    // Create input fields with shorter labels
    const dateTimeInput = new TextInputBuilder()
        .setCustomId('interview_datetime')
        .setLabel('Interview Date/Time') // Shortened label
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., Tomorrow at 3 PM EST')
        .setRequired(true);

    const notesInput = new TextInputBuilder()
        .setCustomId('interview_notes')
        .setLabel('Additional Notes')  // Shortened label
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Any additional information or instructions...')
        .setRequired(false);

    // Add inputs to modal
    const firstActionRow = new ActionRowBuilder().addComponents(dateTimeInput);
    const secondActionRow = new ActionRowBuilder().addComponents(notesInput);
    modal.addComponents(firstActionRow, secondActionRow);

    await interaction.showModal(modal);
});

// Handle interview scheduling modal submission
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith('schedule_interview_')) return;

    const applicantId = interaction.customId.split('_')[2];
    const dateTime = interaction.fields.getTextInputValue('interview_datetime');
    const notes = interaction.fields.getTextInputValue('interview_notes');

    try {
        const applicant = await interaction.guild.members.fetch(applicantId);
        
        // Create interview notification embed
        const interviewEmbed = new EmbedBuilder()
            .setTitle("🗣️ Interview Scheduled")
            .setDescription([
                `Hello ${applicant}, your moderator application interview has been scheduled.`,
                "",
                `**Date/Time:** ${dateTime}`,
                notes ? `**Additional Notes:**\n${notes}` : '',
                "",
                "Please make sure to be available at the scheduled time."
            ].join('\n'))
            .setColor("#0099FF")
            .setTimestamp();

        // Send DM to applicant
        try {
            await applicant.send({ embeds: [interviewEmbed] });
        } catch (error) {
            console.error("Could not DM applicant:", error);
        }

        // Update the original message
        await interaction.update({
            content: `📅 Interview scheduled by ${interaction.user.tag}`,
            components: [] // Remove buttons
        });

        // Log the interview scheduling
        const logChannelId = db.prepare('SELECT log_channel FROM guild_settings WHERE guild_id = ?')
            .get(interaction.guild.id)?.log_channel;

        if (logChannelId) {
            const logChannel = await interaction.guild.channels.fetch(logChannelId);
            if (logChannel) {
                await logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle("📝 Moderator Application Interview Scheduled")
                            .setDescription([
                                `**Applicant:** ${applicant.user.tag}`,
                                `**Scheduled by:** ${interaction.user.tag}`,
                                `**Date/Time:** ${dateTime}`,
                                notes ? `**Additional Notes:**\n${notes}` : '',
                                `**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`
                            ].join('\n'))
                            .setColor("#0099FF")
                    ]
                });
            }
        }

    } catch (error) {
        console.error("Error scheduling interview:", error);
        await interaction.reply({
            content: "❌ An error occurred while scheduling the interview.",
            flags: 64
        });
    }
});

// Helper function to format moderator application transcript
function formatModApplicationTranscript(messages) {
    let transcript = '=== MODERATOR APPLICATION TRANSCRIPT ===\n\n';
    
    // Find application data
    const applicationEmbed = messages.find(msg => 
        msg.embeds[0]?.title === "📝 Moderator Application Summary"
    );

    if (applicationEmbed && applicationEmbed.embeds[0]) {
        const embed = applicationEmbed.embeds[0];
        transcript += `Applicant: ${embed.description}\n\n`;
        
        // Add all Q&A
        embed.fields.forEach(field => {
            if (field.name.startsWith('Q')) {
                transcript += `${field.name}:\n${field.value}\n\n`;
            }
        });
        
        // Add user info
        const userInfoFields = embed.fields.filter(field => 
            field.name.includes('User ID') || field.name.includes('Account Created')
        );
        
        transcript += '\n=== USER INFO ===\n';
        userInfoFields.forEach(field => {
            transcript += `${field.name}: ${field.value}\n`;
        });
    }

    // Add all subsequent messages (discussion, decisions, etc.)
    transcript += '\n=== TICKET DISCUSSION ===\n\n';
    messages.forEach(msg => {
        if (!msg.embeds.length || msg.embeds[0]?.title !== "📝 Moderator Application Summary") {
            const timestamp = new Date(msg.createdTimestamp).toLocaleString();
            transcript += `[${timestamp}] ${msg.author.tag}: ${msg.content}\n`;
        }
    });

    return transcript;
}

// Send Message Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === "sendmessage_modal") {
        const userId = interaction.user.id;
        const targetChannelId = client.tempChannelStore?.[userId];
        
        if (!targetChannelId) {
            return interaction.reply({ 
                content: "❌ No channel was selected.", 
                flags: 64 
            });
        }

        const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel || !targetChannel.isTextBased()) {
            return interaction.reply({ 
                content: "❌ The selected channel is no longer valid.", 
                flags: 64 
            });
        }

        let messageContent = interaction.fields.getTextInputValue("message_content");

        // Process channel mentions in the message content
        // This regex finds patterns like #channel-name and replaces them with proper channel mentions
        const channelMentionRegex = /#([a-zA-Z0-9_-]+)/g;
        
        // Replace channel names with proper mentions if they exist
        messageContent = messageContent.replace(channelMentionRegex, (match, channelName) => {
            const channel = interaction.guild.channels.cache.find(
                ch => ch.name.toLowerCase() === channelName.toLowerCase()
            );
            return channel ? `<#${channel.id}>` : match;
        });

        try {
            // Send message with proper formatting
            await targetChannel.send({
                content: messageContent || "\u200B", // Add empty character if content is empty
                allowedMentions: { parse: ['users', 'roles', 'channels'] }
            });

            delete client.tempChannelStore[userId];

            await interaction.reply({ 
                content: `✅ Message sent to ${targetChannel}!`, 
                flags: 64 
            });
        } catch (error) {
            console.error('Error sending message:', error);
            await interaction.reply({ 
                content: "❌ Failed to send message. Please try again.", 
                flags: 64 
            });
        }
    }
});

// Handle message submission from the modal
client.on("interactionCreate", async interaction => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === "sendmessage_modal") {
        const userId = interaction.user.id;
        const targetChannelId = client.tempChannelStore?.[userId];
        
        if (!targetChannelId) {
            return interaction.reply({ 
                content: "❌ No channel was selected.", 
                flags: 64 
            });
        }

        const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel || !targetChannel.isTextBased()) {
            return interaction.reply({ 
                content: "❌ The selected channel is no longer valid.", 
                flags: 64 
            });
        }

        const messageContent = interaction.fields.getTextInputValue("message_content");

        try {
            // Send message with proper formatting
            await targetChannel.send({
                content: messageContent || "\u200B", // Add empty character if content is empty
                allowedMentions: { parse: ['users', 'roles'] }
            });

            delete client.tempChannelStore[userId];

            await interaction.reply({ 
                content: `✅ Message sent to ${targetChannel}!`, 
                flags: 64 
            });
        } catch (error) {
            console.error('Error sending message:', error);
            await interaction.reply({ 
                content: "❌ Failed to send message. Please try again.", 
                flags: 64 
            });
        }
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

// Death Battle Command data

const WEAPON_GIFS = {
    omniwrench: [
        "https://media.tenor.com/E7VxfVAeqOIAAAAC/sword-attack.gif",
        "https://media.tenor.com/E6c_Qj_TIhQAAAAC/sword-slice.gif"
    ],
    ryno: [
        "https://media.tenor.com/xJlx-a0UlLcAAAAd/metal-gear-rising-raiden.gif",
        "https://media.tenor.com/DrSELrunh9gAAAAC/black-blackman.gif"
    ],
    default: [
        "https://media.tenor.com/K6DgsMs918UAAAAi/xqcsmash-rage.gif",
        "https://media.tenor.com/p9_q4Bfmt8YAAAAd/two-people-fighting-fight.gif",
        "https://media.tenor.com/qC6EyHfCQncAAAAd/rock-lee-gaara.gif",
        "https://media.tenor.com/3_bw0IE43nQAAAAd/fawlty-towers-john-cleese.gif"
    ]
};

const BASE_HP = 100;
const BATTLE_DELAY = 1000;

// Utility functions
function getEquippedWeapon(equipment) {
    const weapon = equipment.find(item => item.category.toLowerCase() === 'weapon');
    return {
        name: weapon ? weapon.name : "Punch",
        type: weapon ? weapon.name.toLowerCase().split(' ')[0] : "default"
    };
}

function calculatePlayerBonuses(userId) {
    return shopDB.prepare(`
        SELECT 
            COALESCE(SUM(damage_bonus), 0) as damage,
            COALESCE(SUM(health_bonus), 0) as health,
            COALESCE(SUM(crit_chance_bonus), 0) as critChance,
            COALESCE(SUM(crit_damage_bonus), 0) as critDamage
        FROM shop_items si 
        JOIN user_inventory ui ON si.item_id = ui.item_id 
        WHERE ui.user_id = ? AND ui.is_equipped = 1
    `).get(userId);
}

function getEquipmentInfo(userId) {
    return shopDB.prepare(`
        SELECT si.name, si.category
        FROM shop_items si 
        JOIN user_inventory ui ON si.item_id = ui.item_id 
        WHERE ui.user_id = ? AND ui.is_equipped = 1
    `).all(userId);
}

function formatEquipmentText(equipment) {
    return equipment.length ? equipment.map(item => `${item.name} (${item.category})`).join(", ") : "No equipment";
}

function getRandomGif(weaponType) {
    const gifs = WEAPON_GIFS[weaponType] || WEAPON_GIFS.default;
    return gifs[Math.floor(Math.random() * gifs.length)];
}

// Battle System
class DeathBattle {
    constructor(interaction, fighter1, fighter2) {
        this.interaction = interaction;
        this.fighter1 = this.initializeFighter(fighter1);
        this.fighter2 = this.initializeFighter(fighter2);
        this.turn = Math.random() < 0.5 ? 1 : 2;
        this.battleLog = [];
        this.battleEmbed = null;

    }

    initializeFighter(user) {
        const bonuses = calculatePlayerBonuses(user.id);
        return {
            id: user.id,
            name: user.username,
            hp: BASE_HP + bonuses.health,
            maxHp: BASE_HP + bonuses.health,
            bonuses,
            equipment: getEquipmentInfo(user.id)
        };
    }

    createBattleEmbed() {
        return new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("⚔️ **DEATH BATTLE BEGINS!** ⚔️")
            .setDescription(`🔥 **${this.fighter1.name}** vs **${this.fighter2.name}** 🔥`)
            .addFields(this.getBattleFields())
            .setImage("http://media1.tenor.com/m/I7QkHH-wak4AAAAd/rumble-wwf.gif")
            .setFooter({ text: "Who will survive?" });
    }

    getBattleFields() {
        return [
            {
                name: "💥 Current Health",
                value: this.getBattleStatus()
            },
            {
                name: "⚔️ Battle Log",
                value: this.getLatestLogs()
            }
        ];
    }

    getBattleStatus() {
        const createFighterStatus = (fighter) => {
            return [
                `**${fighter.name}** (${Math.max(fighter.hp, 0)}/${fighter.maxHp} HP)`,
                `DMG+${fighter.bonuses.damage} | CRIT: ${(fighter.bonuses.critChance*100).toFixed(1)}%`,
                `Equipment: ${formatEquipmentText(fighter.equipment)}`
            ].join('\n');
        };

        return `🟥 ${createFighterStatus(this.fighter1)}\n\n🟦 ${createFighterStatus(this.fighter2)}`;
    }

    getLatestLogs() {
        return this.battleLog.length ? this.battleLog.slice(-5).join("\n") : "*The fight is about to begin...*";
    }

    async processTurn() {
        const attacker = this.turn === 1 ? this.fighter1 : this.fighter2;
        const defender = this.turn === 1 ? this.fighter2 : this.fighter1;
        
        const weapon = getEquippedWeapon(attacker.equipment);
        const { damage, isCrit } = this.calculateDamage(attacker.bonuses);
        
        defender.hp -= damage;
        
        this.battleLog.push(this.createAttackLog(attacker, defender, weapon, damage, isCrit));
        
        await this.updateBattleEmbed(getRandomGif(weapon.type));
        this.turn = this.turn === 1 ? 2 : 1;
    }

    calculateDamage(bonuses) {
        let damage = Math.floor(Math.random() * 6) + 5 + bonuses.damage;
        const isCrit = Math.random() < (bonuses.critChance || 0);
        
        if (isCrit) {
            damage *= 1.5 + (bonuses.critDamage || 0);
        }
        
        return { damage: Math.floor(damage), isCrit };
    }

    createAttackLog(attacker, defender, weapon, damage, isCrit) {
        return isCrit
            ? `💥 **${attacker.name}** lands a critical hit with their **${weapon.name}** on **${defender.name}** for **${damage}** damage!`
            : `⚔️ **${attacker.name}** attacks with their **${weapon.name}** dealing **${damage}** damage to **${defender.name}**!`;
    }

    async updateBattleEmbed(gifUrl) {
        this.battleEmbed
            .setFields(this.getBattleFields())
            .setImage(gifUrl);
        
        await this.interaction.editReply({ embeds: [this.battleEmbed] });
    }

    async handleBattleEnd() {
        const winner = this.fighter1.hp > 0 ? this.fighter1 : this.fighter2;
        const loser = this.fighter1.hp > 0 ? this.fighter2 : this.fighter1;
        
        const rewards = this.calculateRewards();
        await this.distributeRewards(winner.id, loser.id, rewards);
        
        this.battleEmbed
            .setTitle("⚔️ **DEATH BATTLE FINISHED!** ⚔️")
            .setDescription(this.createVictoryDescription(winner, loser, rewards))
            .setColor("#50C878")
            .setFooter({ text: "Battle Complete!" })
            .setImage("https://media1.tenor.com/m/KFpjUU9RL34AAAAd/rivet-dance.gif");
        
        await this.interaction.editReply({ embeds: [this.battleEmbed] });
    }

    calculateRewards() {
        const baseReward = Math.floor(Math.random() * 51) + 50; // 50-100
        return {
            winner: Math.floor(baseReward * 1.5),
            loser: Math.floor(baseReward * 0.5)
        };
    }

    async distributeRewards(winnerId, loserId, rewards) {
        const stmt = shopDB.prepare(`
            UPDATE user_currency 
            SET balance = balance + ? 
            WHERE user_id = ?
        `);
        
        await Promise.all([
            stmt.run(rewards.winner, winnerId),
            stmt.run(rewards.loser, loserId),
            this.updateBattleStats(winnerId, true),
            this.updateBattleStats(loserId, false)
        ]);
    }

    createVictoryDescription(winner, loser, rewards) {
        return [
            `🏆 **${winner.name}** is victorious!`,
            '',
            '💰 **Battle Rewards:**',
            `Winner (${winner.name}): **${rewards.winner}** bolts`,
            `Loser (${loser.name}): **${rewards.loser}** bolts`,
            '',
            '📊 **Final Stats:**',
            `🟥 **${this.fighter1.name}**: ${Math.max(this.fighter1.hp, 0)}/${this.fighter1.maxHp} HP remaining`,
            `🟦 **${this.fighter2.name}**: ${Math.max(this.fighter2.hp, 0)}/${this.fighter2.maxHp} HP remaining`
        ].join('\n');
    }

    async updateBattleStats(userId, isWin) {
        try {
            shopDB.prepare(`
                INSERT INTO deathbattle_stats (user_id, wins, losses)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                wins = wins + ?,
                losses = losses + ?
            `).run(userId, isWin ? 1 : 0, isWin ? 0 : 1, isWin ? 1 : 0, isWin ? 0 : 1);
        } catch (error) {
            console.error('Error updating battle stats:', error);
        }
    }

    async start() {
        this.battleEmbed = this.createBattleEmbed();
        await this.interaction.reply({ embeds: [this.battleEmbed] });
        
        while (this.fighter1.hp > 0 && this.fighter2.hp > 0) {
            await this.processTurn();
            await new Promise(resolve => setTimeout(resolve, BATTLE_DELAY));
        }
        
        await this.handleBattleEnd();
    }
}

// Command handler
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-deathbattle") return;

    const fighter1 = interaction.options.getUser("fighter1");
    const fighter2 = interaction.options.getUser("fighter2");

    if (fighter1.id === fighter2.id) {
        return interaction.reply({ content: "❌ You cannot fight yourself!", flags: 64 });
    }

    try {
        const battle = new DeathBattle(interaction, fighter1, fighter2);
        await battle.start();
    } catch (error) {
        console.error("Battle error:", error);
        await interaction.reply({ 
            content: "❌ An error occurred during the battle!", 
            flags: 64 
        });
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
        const now = Date.now();
        
        // Get active events - modified query to only check end_date and active status
        const activeEvents = shopDB.prepare(`
            SELECT name FROM events 
            WHERE active = 1 AND end_date >= ?
        `).all(now);

        // Fetch regular categories (non-event items)
        const regularCategories = shopDB.prepare(`
            SELECT DISTINCT category FROM shop_items 
            WHERE event_name IS NULL
        `).all();

        // Fetch event categories (only from active events)
        const eventCategories = shopDB.prepare(`
            SELECT DISTINCT category FROM shop_items 
            WHERE event_name IN (
                SELECT name FROM events 
                WHERE active = 1 AND end_date >= ?
            )
        `).all(now);

        if (regularCategories.length === 0 && eventCategories.length === 0) {
            return interaction.reply({ 
                content: "❌ The shop is currently empty!", 
                flags: 64 
            });
        }

        // Create category dropdown options
        const categoryOptions = [
            // Regular categories
            ...regularCategories.map(cat => ({
                label: cat.category,
                value: `regular_${cat.category}`,
                emoji: "🛍️"
            })),
            // Event categories
            ...eventCategories.map(cat => ({
                label: `${cat.category} (Event)`,
                value: `event_${cat.category}`,
                emoji: "🎉"
            }))
        ];

        const categoryMenu = new StringSelectMenuBuilder()
            .setCustomId("shop_category")
            .setPlaceholder("Select a category")
            .addOptions(categoryOptions);

        const actionRow = new ActionRowBuilder().addComponents(categoryMenu);

        // Create shop embed
        const shopEmbed = new EmbedBuilder()
            .setTitle("🛍️ Welcome to the Shop!")
            .setDescription([
                "Select a category to view items:",
                "",
                regularCategories.length > 0 ? "🛍️ **Regular Categories:**" : "",
                regularCategories.map(cat => `• ${cat.category}`).join('\n'),
                "",
                eventCategories.length > 0 ? "🎉 **Event Categories:**" : "",
                eventCategories.map(cat => `• ${cat.category}`).join('\n')
            ].filter(line => line !== "").join('\n'))
            .setColor("#FFD700");

        // Add active events field
        if (activeEvents.length > 0) {
            const eventsList = activeEvents.map(event => {
                const eventData = shopDB.prepare(`
                    SELECT end_date FROM events WHERE name = ?
                `).get(event.name);
                
                const timeLeft = Math.ceil((eventData.end_date - now) / (1000 * 60 * 60 * 24));
                return `🎉 **${event.name}** (${timeLeft} days remaining)`;
            }).join('\n');

            shopEmbed.addFields({
                name: "📅 Active Events",
                value: eventsList
            });
        }

        return interaction.reply({
            embeds: [shopEmbed],
            components: [actionRow],
            flags: 64
        });
    }
});

// Shop category selection
client.on("interactionCreate", async interaction => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== "shop_category") return;

    const categoryValue = interaction.values[0];
    const [type, ...categoryParts] = categoryValue.split('_');
    const category = categoryParts.join('_'); // Rejoin in case category name contains underscores
    const now = Date.now();

    let items;
    if (type === 'regular') {
        // Fetch regular items with proper category filtering
        items = shopDB.prepare(`
            SELECT * FROM shop_items 
            WHERE LOWER(category) = LOWER(?) 
            AND event_name IS NULL
        `).all(category);
    } else if (type === 'event') {
        // Fetch event items with proper category filtering
        items = shopDB.prepare(`
            SELECT * FROM shop_items 
            WHERE LOWER(category) = LOWER(?) 
            AND event_name IN (
                SELECT name FROM events 
                WHERE active = 1 
                AND end_date >= ?
            )
        `).all(category, now);
    }

    if (!items || items.length === 0) {
        return interaction.reply({ 
            content: "❌ No items found in this category.", 
            flags: 64 
        });
    }

    // Create item selection menu with proper formatting
    const itemOptions = items.map(item => ({
        label: `${item.name} (${item.price} ${CURRENCY_NAME})`,
        value: item.item_id.toString(),
        description: item.description.substring(0, 100), // Truncate long descriptions
        emoji: item.category.toLowerCase().includes('weapon') ? "⚔️" : 
               item.category.toLowerCase().includes('vehicle') ? "🚗" : "🛍️"
    }));

    const itemMenu = new StringSelectMenuBuilder()
        .setCustomId("shop_items")
        .setPlaceholder(`Select a ${category} to purchase`)
        .addOptions(itemOptions);

    const actionRow = new ActionRowBuilder().addComponents(itemMenu);

    // Create category embed with specific formatting for weapons and vehicles
    const categoryEmbed = new EmbedBuilder()
        .setTitle(`${category} Shop`)
        .setColor(
            category.toLowerCase().includes('weapon') ? "#FF0000" :
            category.toLowerCase().includes('vehicle') ? "#0000FF" :
            "#FFD700"
        );

    // Add category-specific fields
    if (category.toLowerCase().includes('weapon')) {
        categoryEmbed.addFields({
            name: "⚔️ Weapon Information",
            value: "These items can be equipped and used in battles!"
        });
    } else if (category.toLowerCase().includes('vehicle')) {
        categoryEmbed.addFields({
            name: "🚗 Vehicle Information",
            value: "These items provide special bonuses when equipped!"
        });
    }

    return interaction.update({
        embeds: [categoryEmbed],
        components: [actionRow]
    });
});

// Handle item selection
client.on("interactionCreate", async interaction => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== "shop_items") return;
    
    const itemId = parseInt(interaction.values[0]);
    
    // Get item with detailed information
    const item = shopDB.prepare(`
        SELECT i.*, e.name as event_name, e.end_date as event_end
        FROM shop_items i
        LEFT JOIN events e ON i.event_name = e.name
        WHERE i.item_id = ?
    `).get(itemId);

    if (!item) {
        return interaction.reply({ 
            content: "❌ This item no longer exists.", 
            flags: 64 
        });
    }

    // Build item details based on category
    const details = [];
    if (item.damage_bonus) details.push(`⚔️ Damage: +${item.damage_bonus}`);
    if (item.health_bonus) details.push(`❤️ Health: +${item.health_bonus}`);
    if (item.crit_chance_bonus) details.push(`🎯 Crit Chance: +${item.crit_chance_bonus}%`);
    if (item.crit_damage_bonus) details.push(`💥 Crit Damage: +${item.crit_damage_bonus}%`);
    if (item.bolt_bonus) details.push(`🔧 Bolt Bonus: +${(item.bolt_bonus * 100).toFixed(0)}%`);

    const embed = new EmbedBuilder()
        .setTitle(`${item.category.toLowerCase().includes('weapon') ? "⚔️" : 
                   item.category.toLowerCase().includes('vehicle') ? "🚗" : "🛍️"} ${item.name}`)
        .setDescription([
            item.description,
            "",
            details.length > 0 ? "**Item Stats:**" : "",
            ...details,
            "",
            `💰 **Price:** ${item.price} ${CURRENCY_NAME} ${CURRENCY_EMOJI}`
        ].filter(line => line !== "").join('\n'))
        .setImage(item.image_url || null)
        .setColor(
            item.category.toLowerCase().includes('weapon') ? "#FF0000" :
            item.category.toLowerCase().includes('vehicle') ? "#0000FF" :
            "#FFD700"
        );

    const button = new ButtonBuilder()
        .setCustomId(`shop_confirm_purchase_${itemId}_${interaction.user.id}`)
        .setLabel("Purchase Item")
        .setStyle(ButtonStyle.Success);

    const actionRow = new ActionRowBuilder().addComponents(button);

    return interaction.update({
        embeds: [embed],
        components: [actionRow]
    });
});

// Handle Purchase Confirmation
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton() || !interaction.customId?.startsWith("shop_confirm_purchase_")) return;

    const args = interaction.customId.split("_");
    if (args.length < 5) {
        return interaction.reply({ content: "❌ Invalid interaction data.", flags: 64 });
    }

    const itemId = parseInt(args[3]);
    const confirmUserId = args[4];

    if (!itemId || !confirmUserId || interaction.user.id !== confirmUserId) {
        return interaction.reply({
            content: "❌ You cannot confirm someone else's purchase!",
            flags: 64,
        });
    }

    // Get item with event information
    const item = shopDB.prepare(`
        SELECT i.*, e.name as event_name, e.end_date as event_end
        FROM shop_items i
        LEFT JOIN events e ON i.event_name = e.name
        WHERE i.item_id = ?
    `).get(itemId);

    if (!item) {
        return interaction.update({
            content: "❌ This item is no longer available.",
            components: [],
            embeds: [],
            flags: 64
        });
    }

    // Check if event item is still available
    if (item.event_name && item.event_end) {
        if (Date.now() > item.event_end) {
            return interaction.update({
                content: `❌ This event item is no longer available! The **${item.event_name}** event has ended.`,
                components: [],
                embeds: [],
                flags: 64
            });
        }
    }

    // Check user balance
    let userData = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(interaction.user.id);
    if (!userData) {
        shopDB.prepare("INSERT INTO user_currency (user_id, balance) VALUES (?, ?)").run(interaction.user.id, 0);
        userData = { balance: 0 };
    }

    if (userData.balance < item.price) {
        return interaction.update({
            content: `❌ Not enough ${CURRENCY_NAME}! You need **${item.price}** ${CURRENCY_EMOJI} (You have: **${userData.balance}** ${CURRENCY_EMOJI})`,
            components: [],
            embeds: [],
            flags: 64
        });
    }

    // Check for duplicate items
    const existingItem = shopDB.prepare(
        "SELECT * FROM user_inventory WHERE user_id = ? AND item_id = ?"
    ).get(interaction.user.id, itemId);

    if (existingItem) {
        return interaction.update({
            content: "❌ You already own this item!",
            components: [],
            embeds: [],
            flags: 64
        });
    }

    // Process purchase
    try {
        // Start transaction
        const transaction = shopDB.transaction(() => {
            // Deduct currency
            shopDB.prepare(
                "UPDATE user_currency SET balance = balance - ? WHERE user_id = ?"
            ).run(item.price, interaction.user.id);

            // Add item to inventory
            shopDB.prepare(
                "INSERT INTO user_inventory (user_id, item_id) VALUES (?, ?)"
            ).run(interaction.user.id, itemId);
        });

        transaction();

        // Create success embed
        const successEmbed = new EmbedBuilder()
            .setTitle("✅ Purchase Successful!")
            .setColor("#00FF00")
            .setDescription([
                `You purchased **${item.name}** for **${item.price}** ${CURRENCY_EMOJI}`,
                "",
                "**Item Details:**",
                item.description,
                "",
                `Remaining balance: **${userData.balance - item.price}** ${CURRENCY_EMOJI}`
            ].join('\n'))
            .setThumbnail(item.image_url || null);

        // Add event information if applicable
        if (item.event_name) {
            successEmbed.addFields({
                name: "🎉 Event Item",
                value: `Part of the **${item.event_name}** event`
            });
        }

        await interaction.update({
            content: null,
            embeds: [successEmbed],
            components: [],
        });

    } catch (error) {
        console.error("Purchase Error:", error);
        return interaction.update({
            content: "❌ An error occurred while processing your purchase. Please try again.",
            components: [],
            embeds: [],
            flags: 64
        });
    }
});

// additem Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-additem") return;

    // Admin permission check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({ 
            content: "❌ You don't have permission to add items.", 
            flags: 64 
        });
    }

    // Get all input values
    const itemData = {
        name: interaction.options.getString("name"),
        description: interaction.options.getString("description"),
        price: interaction.options.getInteger("price"),
        category: interaction.options.getString("category"),
        imageUrl: interaction.options.getString("image"),
        eventName: interaction.options.getString("event"),
        // Bonus stats
        damageBonus: interaction.options.getInteger("damage_bonus") || 0,
        healthBonus: interaction.options.getInteger("health_bonus") || 0,
        critChance: interaction.options.getNumber("crit_chance_bonus") || 0,
        critDamage: interaction.options.getNumber("crit_damage_bonus") || 0,
        boltBonus: interaction.options.getNumber("bolt_bonus") || 0
    };

    // Validate input
    if (itemData.price < 0) {
        return interaction.reply({
            content: "❌ Price cannot be negative.",
            flags: 64
        });
    }

    // Check for duplicate item names
    const existingItem = shopDB.prepare("SELECT name FROM shop_items WHERE name = ?").get(itemData.name);
    if (existingItem) {
        return interaction.reply({
            content: "❌ An item with this name already exists.",
            flags: 64
        });
    }

    // Check if event exists (if specified)
    let eventInfo = null;
    if (itemData.eventName) {
        eventInfo = shopDB.prepare("SELECT * FROM events WHERE name = ?").get(itemData.eventName);
        if (!eventInfo) {
            return interaction.reply({
                content: "❌ The specified event doesn't exist in the database.",
                flags: 64
            });
        }
    }

    try {
        // Insert item into database
        const result = shopDB.prepare(`
            INSERT INTO shop_items (
                name, description, price, category, image_url,
                damage_bonus, health_bonus, crit_chance_bonus,
                crit_damage_bonus, bolt_bonus, event_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            itemData.name,
            itemData.description,
            itemData.price,
            itemData.category,
            itemData.imageUrl,
            itemData.damageBonus,
            itemData.healthBonus,
            itemData.critChance,
            itemData.critDamage,
            itemData.boltBonus,
            itemData.eventName
        );

        // Create confirmation embed
        const embed = new EmbedBuilder()
            .setTitle("✅ Item Added Successfully!")
            .setDescription([
                `Added **${itemData.name}** to the shop`,
                "",
                "**Description:**",
                itemData.description
            ].join('\n'))
            .setColor(itemData.eventName ? "#FF69B4" : "#00FF00");

        // Add basic info field
        const basicInfo = [
            `💰 Price: **${itemData.price}** ${CURRENCY_NAME}`,
            `📁 Category: **${itemData.category}**`
        ];

        // Add event information if applicable
        if (eventInfo) {
            const eventStatus = Date.now() <= eventInfo.end_date ? "🟢 Active" : "🔴 Ended";
            basicInfo.push(
                `🎉 Event: **${eventInfo.name}**`,
                `📅 Status: ${eventStatus}`,
                `⏰ End Date: <t:${Math.floor(eventInfo.end_date / 1000)}:F>`
            );
        } else {
            basicInfo.push(`🎉 Event: **None**`);
        }

        embed.addFields({ 
            name: "Basic Info", 
            value: basicInfo.join('\n'),
            inline: false 
        });

        // Add bonus stats if any exist
        const bonuses = [];
        if (itemData.damageBonus) bonuses.push(`⚔️ +${itemData.damageBonus} Damage`);
        if (itemData.healthBonus) bonuses.push(`❤️ +${itemData.healthBonus} Health`);
        if (itemData.critChance) bonuses.push(`🎯 +${itemData.critChance}% Crit Chance`);
        if (itemData.critDamage) bonuses.push(`💥 +${itemData.critDamage}% Crit Damage`);
        if (itemData.boltBonus) bonuses.push(`🔧 +${(itemData.boltBonus * 100).toFixed(0)}% Bolt Gains`);

        if (bonuses.length > 0) {
            embed.addFields({ 
                name: "Item Bonuses", 
                value: bonuses.join('\n'),
                inline: false 
            });
        }

        // Add image if provided
        if (itemData.imageUrl) {
            embed.setThumbnail(itemData.imageUrl);
        }

        // Add database info
        embed.addFields({
            name: "Database Info",
            value: `Item ID: \`${result.lastInsertRowid}\``,
            inline: false
        });

        return interaction.reply({ 
            embeds: [embed], 
            flags: 64 
        });

    } catch (error) {
        console.error("Error adding item:", error);
        return interaction.reply({ 
            content: "❌ An error occurred while adding the item to the shop.", 
            flags: 64 
        });
    }
});

// inventory Command
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-inventory") return;

    const userId = interaction.user.id;
    const guild = interaction.guild;

    // Fetch the user's server profile picture
    const member = await guild.members.fetch(userId).catch(() => null);
    const profilePicture = member?.avatar
        ? `https://cdn.discordapp.com/guilds/${guild.id}/users/${userId}/avatars/${member.avatar}.png?size=512`
        : interaction.user.displayAvatarURL({ dynamic: true });

    // Fetch all items with event information
    const items = shopDB.prepare(`
        SELECT si.*, ui.is_equipped, e.name as event_name, e.end_date as event_end
        FROM user_inventory ui 
        JOIN shop_items si ON ui.item_id = si.item_id 
        LEFT JOIN events e ON si.event_name = e.name
        WHERE ui.user_id = ?
        ORDER BY si.category, si.name
    `).all(userId);

    if (!items.length) {
        return interaction.reply({
            content: "🛒 Your inventory is empty! Purchase items from the shop using `/tgc-shop`.",
            flags: 64
        });
    }

    // Group items by category
    const itemsByCategory = items.reduce((acc, item) => {
        if (!acc[item.category]) {
            acc[item.category] = [];
        }
        acc[item.category].push(item);
        return acc;
    }, {});

    // Pagination setup
    let page = 0;
    const categoriesArray = Object.keys(itemsByCategory);
    const totalPages = categoriesArray.length;

    function generateEmbed(page) {
        const currentCategory = categoriesArray[page];
        const categoryItems = itemsByCategory[currentCategory];

        const embed = new EmbedBuilder()
            .setColor("#FFD700")
            .setTitle(`${member?.displayName || interaction.user.username}'s Inventory`)
            .setThumbnail(profilePicture)
            .setFooter({ text: `Category ${page + 1} of ${totalPages}` });

        // Add items from current category
        const itemsList = categoryItems.map(item => {
            const bonuses = [];
            if (item.damage_bonus) bonuses.push(`⚔️ +${item.damage_bonus} Damage`);
            if (item.health_bonus) bonuses.push(`❤️ +${item.health_bonus} Health`);
            if (item.crit_chance_bonus) bonuses.push(`🎯 +${item.crit_chance_bonus}% Crit Chance`);
            if (item.crit_damage_bonus) bonuses.push(`💥 +${item.crit_damage_bonus}% Crit Damage`);
            if (item.bolt_bonus) bonuses.push(`🔧 +${(item.bolt_bonus * 100).toFixed(0)}% Bolt Gains`);

            const isEventItem = item.event_name && item.event_end;
            const eventStatus = isEventItem 
                ? (Date.now() <= item.event_end 
                    ? `🎉 Event Item: **${item.event_name}** (Ends <t:${Math.floor(item.event_end / 1000)}:R>)`
                    : `🏆 Limited Item: **${item.event_name}**`)
                : '';

            return [
                `📦 ${isEventItem ? '✨' : ''} **${item.name}** ${item.is_equipped ? '✅' : ''}`,
                eventStatus,
                `💰 Value: **${item.price}** ${CURRENCY_NAME}`,
                bonuses.length > 0 ? `📊 **Bonuses:**\n${bonuses.join('\n')}` : '',
                '───────────────'
            ].filter(line => line !== '').join('\n');
        }).join('\n');

        embed.setDescription([
            `🎒 **${currentCategory} Items:**\n`,
            itemsList,
            '\n📝 **Legend:**',
            '✨ Event/Limited Item',
            '✅ Equipped'
        ].join('\n'));

        return embed;
    }

    // If there's only one page, just send the embed
    if (totalPages === 1) {
        return interaction.reply({ embeds: [generateEmbed(0)] });
    }

    // Pagination buttons
    const prevButton = new ButtonBuilder()
        .setCustomId("prev_inventory")
        .setLabel("◀️ Previous")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true);

    const nextButton = new ButtonBuilder()
        .setCustomId("next_inventory")
        .setLabel("Next ▶️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(totalPages === 1);

    const row = new ActionRowBuilder().addComponents(prevButton, nextButton);

    const replyMessage = await interaction.reply({
        embeds: [generateEmbed(page)],
        components: [row]
    });

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

        await i.update({
            embeds: [generateEmbed(page)],
            components: [row]
        });
    });

    collector.on("end", async () => {
        prevButton.setDisabled(true);
        nextButton.setDisabled(true);
        await interaction.editReply({ components: [row] });
    });
});

// equip command handler
client.on("interactionCreate", async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
    
        if (interaction.commandName === "tgc-equip") {
            const itemName = interaction.options.getString("item");
            const userId = interaction.user.id;
    
            try {
                // First, check if the user owns the item
                const item = shopDB.prepare(`
                    SELECT si.*, ui.is_equipped 
                    FROM shop_items si 
                    JOIN user_inventory ui ON si.item_id = ui.item_id 
                    WHERE ui.user_id = ? AND LOWER(si.name) = LOWER(?)
                `).get(userId, itemName);
    
                if (!item) {
                    return interaction.reply({
                        content: `❌ You don't own an item called "${itemName}"`,
                        flags: 64
                    });
                }
    
                // Check if there's already an equipped item in this category
                if (!item.is_equipped) {
                    const equippedInCategory = shopDB.prepare(`
                        SELECT si.name 
                        FROM shop_items si 
                        JOIN user_inventory ui ON si.item_id = ui.item_id 
                        WHERE ui.user_id = ? AND si.category = ? AND ui.is_equipped = 1
                    `).get(userId, item.category);
    
                    if (equippedInCategory) {
                        return interaction.reply({
                            content: `❌ You already have "${equippedInCategory.name}" equipped in the ${item.category} category. Please unequip it first.`,
                            flags: 64
                        });
                    }
                }
    
                // Toggle equipped status
                const newStatus = item.is_equipped ? 0 : 1;
                shopDB.prepare(`
                    UPDATE user_inventory 
                    SET is_equipped = ? 
                    WHERE user_id = ? AND item_id = ?
                `).run(newStatus, userId, item.item_id);
    
                // Create response embed
                const embed = new EmbedBuilder()
                    .setColor(newStatus ? "#00FF00" : "#FF0000")
                    .setTitle(newStatus ? "🎮 Item Equipped" : "📦 Item Unequipped")
                    .setDescription(`Successfully ${newStatus ? "equipped" : "unequipped"} **${item.name}**`)
                    .addFields(
                        { name: "Category", value: item.category, inline: true },
                        { name: "Bonuses", value: getBonusText(item), inline: true }
                    );
    
                await interaction.reply({
                    embeds: [embed],
                    flags: 64
                });
    
            } catch (error) {
                console.error("Error in equip command:", error);
                await interaction.reply({
                    content: "❌ An error occurred while processing your request.",
                    flags: 64
                });
            }
        }
});
    
// Utility function to format bonus text
function getBonusText(item) {
        const bonuses = [];
        if (item.damage_bonus) bonuses.push(`+${item.damage_bonus} Damage`);
        if (item.health_bonus) bonuses.push(`+${item.health_bonus} Health`);
        if (item.crit_chance_bonus) bonuses.push(`+${item.crit_chance_bonus}% Crit Chance`);
        if (item.crit_damage_bonus) bonuses.push(`+${item.crit_damage_bonus}% Crit Damage`);
        return bonuses.length > 0 ? bonuses.join('\n') : 'None';
}

// Autocomplete for item names
 client.on('interactionCreate', async interaction => {
        if (!interaction.isAutocomplete()) return;
    
        if (interaction.commandName === 'tgc-giveitem') {
            const focusedValue = interaction.options.getFocused().toLowerCase();
            
            try {
                // Fetch all items from the shop
                const items = shopDB.prepare(`
                    SELECT name 
                    FROM shop_items 
                    WHERE LOWER(name) LIKE ?
                    LIMIT 25
                `).all(`%${focusedValue}%`);
    
                const choices = items.map(item => ({
                    name: item.name,
                    value: item.name
                }));
    
                await interaction.respond(choices);
            } catch (error) {
                console.error('Error in giveitem autocomplete:', error);
                await interaction.respond([]);
            }
        }
});
    
// Command to give an item to a user
client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-giveitem") return;
    
        // Permission Check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
        }
    
        const targetUser = interaction.options.getUser("user");
        const itemName = interaction.options.getString("item");
    
        try {
            // Check if item exists
            const item = shopDB.prepare(`
                SELECT item_id, name 
                FROM shop_items 
                WHERE name = ?
            `).get(itemName);
    
            if (!item) {
                return interaction.reply({
                    content: `❌ Item "${itemName}" not found in the shop.`,
                    flags: 64
                });
            }
    
            // Check if user already has the item
            const existingItem = shopDB.prepare(`
                SELECT * FROM user_inventory 
                WHERE user_id = ? AND item_id = ?
            `).get(targetUser.id, item.item_id);
    
            if (existingItem) {
                return interaction.reply({
                    content: `❌ ${targetUser.username} already owns "${item.name}".`,
                    flags: 64
                });
            }
    
            // Give item to user
            shopDB.prepare(`
                INSERT INTO user_inventory (user_id, item_id) 
                VALUES (?, ?)
            `).run(targetUser.id, item.item_id);
    
            await interaction.reply({
                content: `✅ Successfully gave "${item.name}" to ${targetUser.username}.`,
                flags: 64
            });
    
        } catch (error) {
            console.error('Error in giveitem command:', error);
            await interaction.reply({
                content: '❌ An error occurred while processing the command.',
                flags: 64
            });
        }
});

// Command to create an event
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "tgc-createevent") {
        // Permission check
        if (!checkCommandPermission(interaction)) {
            return interaction.reply({
                content: 'You do not have permission to use this command.',
                flags: 64
            });
        }

        const eventName = interaction.options.getString("name");

        try {
            // Check if event name already exists
            const existingEvent = shopDB.prepare(`
                SELECT name FROM events WHERE name = ?
            `).get(eventName);

            if (existingEvent) {
                return interaction.reply({
                    content: "❌ An event with this name already exists.",
                    flags: 64
                });
            }

            // Insert new event
            shopDB.prepare(`
                INSERT INTO events (name, active, created_at)
                VALUES (?, 0, ?)
            `).run(eventName, Date.now());

            const embed = new EmbedBuilder()
                .setTitle("✨ Event Created!")
                .setDescription([
                    `Successfully created the **${eventName}** event!`,
                    '',
                    '**Note:** Use `/tgc-startevent` to activate this event.'
                ].join('\n'))
                .addFields(
                    { name: "Status", value: "⏸️ Not Active", inline: true },
                    { name: "Created", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                )
                .setColor("#FFA500")
                .setFooter({ text: 'Use /tgc-startevent to begin the event' });

            await interaction.reply({ 
                embeds: [embed], 
                flags: 64 
            });

        } catch (error) {
            console.error("Error creating event:", error);
            await interaction.reply({
                content: "❌ An error occurred while creating the event. Please check the event name and try again.",
                flags: 64
            });
        }
    }
});

// Command to start an event
client.on("interactionCreate", async interaction => {
    if (interaction.isAutocomplete() && interaction.commandName === "tgc-startevent") {
        const focusedValue = interaction.options.getFocused();

        try {
            // Get inactive events
            const events = shopDB.prepare(`
                SELECT name FROM events 
                WHERE active = 0
                AND name LIKE ?
                ORDER BY created_at DESC
            `).all(`%${focusedValue}%`);

            const choices = events.map(event => ({
                name: event.name,
                value: event.name
            })).slice(0, 25);

            await interaction.respond(choices);
        } catch (error) {
            console.error("Error in autocomplete:", error);
            await interaction.respond([]);
        }
        return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-startevent") return;

    // Permission check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const eventName = interaction.options.getString("name");
    const eventDuration = interaction.options.getInteger("duration"); // Allow user to override duration

    try {
        // Get event details
        const event = shopDB.prepare(`
            SELECT * FROM events WHERE name = ?
        `).get(eventName);

        if (!event) {
            return interaction.reply({
                content: "❌ Event not found.",
                flags: 64
            });
        }

        if (event.active) {
            return interaction.reply({
                content: "❌ This event is already active.",
                flags: 64
            });
        }

        let durationDays = eventDuration || event.duration; // Use user input if provided
        if (!durationDays || durationDays <= 0) {
            return interaction.reply({
                content: "❌ The event duration is not set. Please specify a duration in days.",
                flags: 64
            });
        }

        const startDate = Date.now();
        const endDate = startDate + (durationDays * 24 * 60 * 60 * 1000);

        // Activate the event and update timestamps
        shopDB.prepare(`
            UPDATE events 
            SET active = 1, 
                start_date = ?,
                end_date = ?,
                duration = ?, 
                last_updated = ?
            WHERE name = ?
        `).run(startDate, endDate, durationDays, startDate, eventName);

        const embed = new EmbedBuilder()
            .setTitle("🎉 Event Started!")
            .setDescription([
                `**${eventName}** event!`,
                '',
                '**Note:** Use `/tgc-shop` to see the event items in the new shop catogory.'
                
            ].join('\n'))
            .addFields(
                { name: "Duration", value: `${durationDays} days`, inline: true },
                { name: "Start Date", value: `<t:${Math.floor(startDate / 1000)}:F>`, inline: true },
                { name: "End Date", value: `<t:${Math.floor(endDate / 1000)}:F>`, inline: true },
                { name: "Status", value: "▶️ Active", inline: true },
                { name: "Time Until End", value: `<t:${Math.floor(endDate / 1000)}:R>`, inline: true }
            )
            .setColor("#00FF00")
            .setFooter({ text: `Event ID: ${eventName}` });

        // Send to channel if specified
        const announceChannel = interaction.options.getChannel("announce-channel");
        if (announceChannel) {
            await announceChannel.send({ embeds: [embed] });
            
            await interaction.reply({ 
                content: `✅ Event started and announced in ${announceChannel}!`,
                flags: 64 
            });
        } else {
            await interaction.reply({ 
                embeds: [embed], 
                flags: 64 
            });
        }

    } catch (error) {
        console.error("Error starting event:", error);
        await interaction.reply({
            content: "❌ An error occurred while starting the event. Please try again.",
            flags: 64
        });
    }
});

// Command to end an event
client.on("interactionCreate", async interaction => {
    if (interaction.isAutocomplete() && interaction.commandName === "tgc-endevent") {
        const focusedValue = interaction.options.getFocused();
        
        // Get active events
        const events = shopDB.prepare(`
            SELECT name FROM events 
            WHERE active = 1
            AND name LIKE ?
        `).all(`%${focusedValue}%`);

        const choices = events.map(event => ({
            name: event.name,
            value: event.name
        })).slice(0, 25);

        await interaction.respond(choices);
        return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-endevent") return;

    // Permission check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const eventName = interaction.options.getString("name");

    try {
        // Get event details
        const event = shopDB.prepare(`
            SELECT * FROM events WHERE name = ?
        `).get(eventName);

        if (!event) {
            return interaction.reply({
                content: "❌ Event not found.",
                flags: 64
            });
        }

        if (!event.active) {
            return interaction.reply({
                content: "❌ This event is not currently active.",
                flags: 64
            });
        }

        // End the event
        shopDB.prepare(`
            UPDATE events 
            SET active = 0
            WHERE name = ?
        `).run(eventName);

        const embed = new EmbedBuilder()
            .setTitle("🏁 Event Ended!")
            .setDescription(`Successfully ended the **${eventName}** event!`)
            .addFields(
                { name: "Duration", value: `${event.duration} days`, inline: true },
                { name: "Status", value: "⏹️ Ended", inline: true }
            )
            .setColor("#FF0000");

        await interaction.reply({ embeds: [embed], flags: 64 });

    } catch (error) {
        console.error("Error ending event:", error);
        await interaction.reply({
            content: "❌ An error occurred while ending the event.",
            flags: 64
        });
    }
});

// earning currency
const messageCooldowns = new Map();

// Function to calculate Bolt bonus based on user ID
client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const now = Date.now();
    const cooldownTime = 60000; // 1 minute cooldown

    if (messageCooldowns.has(userId)) {
        const lastMessageTime = messageCooldowns.get(userId);
        if (now - lastMessageTime < cooldownTime) return;
    }
    
    messageCooldowns.set(userId, now);

    const baseAmount = Math.floor(Math.random() * 5) + 1; // Base amount (1-5)
    const boltMultiplier = calculateBoltBonus(userId);
    const finalAmount = Math.floor(baseAmount * boltMultiplier);

    shopDB.prepare(`
        INSERT INTO user_currency (user_id, balance) 
        VALUES (?, ?) 
        ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?
    `).run(userId, finalAmount, finalAmount);

    console.log(`💰 ${message.author.username} earned ${finalAmount} currency (${boltMultiplier}x multiplier)`);
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
        
        // Biased roll function that reduces winning chances
        const biasedRoll = () => {
            return symbols[Math.floor(Math.random() * symbols.length)];
        };

        // Determine if this spin should be a winner based on probability
        const randomValue = Math.random();
        let slot1, slot2, slot3;
        
        if (randomValue < 0.03) {
            // 3% chance for jackpot (all three matching)
            const selectedSymbol = symbols[Math.floor(Math.random() * symbols.length)];
            slot1 = selectedSymbol;
            slot2 = selectedSymbol;
            slot3 = selectedSymbol;
        } else if (randomValue < 0.15) {
            // 12% chance for small win (two matching)
            const selectedSymbol = symbols[Math.floor(Math.random() * symbols.length)];
            const differentSymbol = symbols.filter(s => s !== selectedSymbol)[Math.floor(Math.random() * (symbols.length - 1))];
            
            // Randomly decide which position gets the different symbol
            const differentPosition = Math.floor(Math.random() * 3);
            if (differentPosition === 0) {
                slot1 = differentSymbol;
                slot2 = selectedSymbol;
                slot3 = selectedSymbol;
            } else if (differentPosition === 1) {
                slot1 = selectedSymbol;
                slot2 = differentSymbol;
                slot3 = selectedSymbol;
            } else {
                slot1 = selectedSymbol;
                slot2 = selectedSymbol;
                slot3 = differentSymbol;
            }
        } else {
            // 85% chance for loss (all different or only partial matches that don't count as wins)
            // Generate three potentially different symbols
            slot1 = biasedRoll();
            
            // Make sure we get a losing combination
            do {
                slot2 = biasedRoll();
                slot3 = biasedRoll();
            } while ((slot1 === slot2 && slot2 === slot3) || 
                    (slot1 === slot2) || 
                    (slot2 === slot3) || 
                    (slot1 === slot3));
        }

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

    // Simulate spin with reduced winning chances
    // Instead of a fair 37 numbers (0-36), we'll use a biased approach
    let winningNumber;
    const randomValue = Math.random();
    
    // Increase the chance of getting numbers that don't match the user's bet
    if (selectedBet === "red") {
        // Bias toward black and green (0)
        if (randomValue < 0.6) {
            // Generate a black number (odd numbers)
            winningNumber = 2 * Math.floor(Math.random() * 18) + 1;
        } else if (randomValue < 0.65) {
            // Green (0)
            winningNumber = 0;
        } else {
            // Red number (even numbers except 0)
            winningNumber = 2 * Math.floor(Math.random() * 18 + 1);
        }
    } else if (selectedBet === "black") {
        // Bias toward red and green (0)
        if (randomValue < 0.6) {
            // Generate a red number (even numbers except 0)
            winningNumber = 2 * Math.floor(Math.random() * 18 + 1);
        } else if (randomValue < 0.65) {
            // Green (0)
            winningNumber = 0;
        } else {
            // Black number (odd numbers)
            winningNumber = 2 * Math.floor(Math.random() * 18) + 1;
        }
    } else {
        // For green (0) bets, make it extremely unlikely to win
        if (randomValue < 0.98) {
            // Generate any non-zero number
            winningNumber = Math.floor(Math.random() * 36) + 1;
        } else {
            winningNumber = 0;
        }
    }

    const winningColor = winningNumber === 0 ? "green" : winningNumber % 2 === 0 ? "red" : "black";

    let winnings = 0;
    if (selectedBet === winningColor) {
        if (selectedBet === "green") {
            winnings = betAmount * 14; // Keep the same payout for the rare green win
        } else {
            winnings = betAmount * 2; // Standard payout for red/black
        }
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

    // Reduce jackpot win chance
    checkJackpotWin(userId, interaction.channel);

    // Embed result
    const rouletteEmbed = new EmbedBuilder()
        .setTitle("🎡 Roulette Spin!")
        .setDescription(`🎲 Winning Number: **${winningNumber}** (${winningColor.toUpperCase()})`)
        .setColor(winnings > 0 ? "#00FF00" : "#FF0000")
        .setFooter({ text: winnings > 0 ? `You won ⚙️ ${winnings}!` : "Better luck next time!" });

    return interaction.reply({ embeds: [rouletteEmbed]});
});

// Toggle Crates Command
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-togglecrates") return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    const channel = interaction.options.getChannel("channel");
    
    try {
        // Check if channel is already disabled
        const isDisabled = db.prepare(
            "SELECT channel_id FROM disabled_crate_channels WHERE channel_id = ?"
        ).get(channel.id);

        if (isDisabled) {
            // Enable crates by removing from disabled list
            db.prepare(
                "DELETE FROM disabled_crate_channels WHERE channel_id = ?"
            ).run(channel.id);

            await interaction.reply({
                content: `✅ Crates will now spawn in ${channel}`,
                flags: 64
            });
        } else {
            // Disable crates by adding to disabled list
            db.prepare(
                "INSERT INTO disabled_crate_channels (channel_id, guild_id) VALUES (?, ?)"
            ).run(channel.id, interaction.guild.id);

            await interaction.reply({
                content: `❌ Crates will no longer spawn in ${channel}`,
                flags: 64
            });
        }
    } catch (error) {
        console.error('Error toggling crate spawns:', error);
        await interaction.reply({
            content: '❌ An error occurred while toggling crate spawns.',
            flags: 64
        });
    }
});

//bolt crates
const boltCrateChances = 0.01; // 1% chance per message
const boltCrates = [
    { name: "Small Crate", min: 50, max: 200, color: "#C0C0C0" },    // Silver
    { name: "Medium Crate", min: 200, max: 500, color: "#FFD700" },  // Gold
    { name: "Large Crate", min: 500, max: 1000, color: "#FF0000" }   // Red
];

client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    // Check if crates are disabled in this channel
    const isDisabled = db.prepare(
        "SELECT channel_id FROM disabled_crate_channels WHERE channel_id = ?"
    ).get(message.channel.id);

    if (isDisabled) return;

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

    const baseAmount = parseInt(interaction.customId.split("_")[3]);
    const userId = interaction.user.id;
    const boltMultiplier = calculateBoltBonus(userId);
    const finalAmount = Math.floor(baseAmount * boltMultiplier);

    shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?")
        .run(finalAmount, userId);

    const embed = new EmbedBuilder()
        .setTitle("✅ Bolt Crate Claimed!")
        .setDescription([
            `**${interaction.user.username}** has claimed the crate and received **${finalAmount} bolts**!`,
            boltMultiplier > 1 ? `*(Includes ${((boltMultiplier - 1) * 100).toFixed(0)}% bonus from equipped items)*` : ''
        ].join('\n'))
        .setColor("#00FF00")
        .setThumbnail("https://static.wikia.nocookie.net/ratchet/images/0/0e/Bolt_crate_from_R%26C_%282002%29_render.png");

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
    if (message.author.bot || !message.guild) return;

    // Check if crates are disabled in this channel
    const isDisabled = db.prepare(
        "SELECT channel_id FROM disabled_crate_channels WHERE channel_id = ?"
    ).get(message.channel.id);

    if (isDisabled) return;

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

// Function to calculate level based on XP
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

// XP Tracking
client.on('messageCreate', (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const guildId = message.guild.id;

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

    // XP gain logic: Generate random XP gain between 5 and 20
    const xpGain = parseFloat((Math.random() * (20 - 5) + 5).toFixed(2));

    // Get user's current XP before update
    const userData = db.prepare(`SELECT xp FROM user_xp WHERE user_id = ?`).get(userId);
    const oldXp = userData ? userData.xp : 0;
    const oldLevel = calculateLevel(oldXp, baseXp, multiplier);

    // Update or insert XP for the user
    db.prepare(`
        INSERT INTO user_xp (user_id, xp)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp
    `).run(userId, xpGain);

    // Fetch total XP for the user after update
    const { xp: totalXp } = db.prepare(`
        SELECT xp FROM user_xp WHERE user_id = ?
    `).get(userId);

    // Calculate the user's current level
    const newLevel = calculateLevel(totalXp, baseXp, multiplier);

    // Check Level Up
    if (newLevel > oldLevel) {
        handleLevelUp(userId, guildId, newLevel);
    }
    
    // Log the XP gain and user's level
    console.log(`User '${message.author.username}' gained ${xpGain} XP, has ${totalXp.toFixed(2)} total XP, and is level ${newLevel}.`);

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
            if (newLevel >= requiredLevel) {
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

function handleLevelUp(userId, guildId, newLevel) {
    // Fetch the set level-up notification channel
    // Using the same db as the rest of the code (changed from shopDB)
    const levelUpChannelData = db.prepare("SELECT channel_id FROM level_up_notifications WHERE guild_id = ?").get(guildId);
    
    if (!levelUpChannelData) return; // No channel set

    const levelUpChannel = client.channels.cache.get(levelUpChannelData.channel_id);
    if (!levelUpChannel) return;

    // 🎉 Level-Up Embed
    const embed = new EmbedBuilder()
        .setTitle("🎉 Level Up!")
        .setDescription(`Congratulations <@${userId}>! You've reached **Level ${newLevel}!** 🚀`)
        .setColor("#00FF00")
        .setThumbnail(client.users.cache.get(userId)?.displayAvatarURL() || null)
        .setFooter({ text: "Keep chatting to level up more!" });

    // Send the notification
    levelUpChannel.send({ content: `<@${userId}>`, embeds: [embed] }).catch(console.error);
}

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

client.once('ready', async () => {
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
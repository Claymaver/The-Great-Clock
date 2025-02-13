const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder,EmbedBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder,StringSelectMenuBuilder,ButtonBuilder,ButtonStyle,ChannelType, PermissionsBitField,StringSelectMenuOptionBuilder } = require('discord.js');require('dotenv').config();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

const Database = require('better-sqlite3');

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
        command_name TEXT NOT NULL,
        role_id TEXT NOT NULL
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
`);

function checkCommandPermission(interaction) {
    if (!interaction.guild) return false;

    const guildId = interaction.guild.id;
    const memberRoles = interaction.member.roles.cache.map((role) => role.id);

    // Fetch allowed roles for the guild
    const allowedRoles = db.prepare(`
        SELECT role_id FROM command_roles WHERE guild_id = ?
    `).all(guildId);

    if (allowedRoles.length === 0) {
        // If no roles are set for the guild, assume all commands are restricted
        return false;
    }

    // Check if any of the member's roles match the allowed roles
    const allowedRoleIds = allowedRoles.map((row) => row.role_id);
    return memberRoles.some((roleId) => allowedRoleIds.includes(roleId));
}

// Ensure schema is updated
try {
    db.prepare(`SELECT multiplier FROM guild_settings LIMIT 1`).get();
    } catch (error) {
        console.log("Updating schema: Adding 'multiplier' column to 'guild_settings'.");
        db.exec(`ALTER TABLE guild_settings ADD COLUMN multiplier REAL DEFAULT 1.2`);
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

// Function to apply a global ban across all guilds
async function applyGlobalBan(client, userId, reason) {
    const guilds = client.guilds.cache;

    if (!guilds.size) {
        console.log("No guilds available to ban the user.");
        return;
    }

    for (const guild of guilds.values()) {
        try {
            const member = await guild.members.fetch(userId).catch(() => null);

            if (member) {
                await guild.bans.create(userId, { reason });
                console.log(`User banned in guild: ${guild.name}`);
            } else {
                console.log(`User not found in guild: ${guild.name}`);
            }
        } catch (error) {
            console.error(`Error banning user in guild: ${guild.name}`, error);
        }
    }
}

// Function to generate progress bar
function generateProgressBar(currentXp, xpForNextLevel, barLength = 20) {
    const progress = Math.max(0, Math.min(currentXp / xpForNextLevel, 1)); // Ensure progress is between 0 and 1
    const filledLength = Math.floor(progress * barLength);
    const emptyLength = barLength - filledLength;

    return '█'.repeat(filledLength) + '░'.repeat(emptyLength); // Create the progress bar
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
                option.setName("duration")
                    .setDescription("Ban duration in hours (optional).")),
    
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
            .setDescription("Unban users."),
    
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

// Predefined Embed Colors
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
    "Default (Teal)": "00AE86"
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
            const averageXpPerMessage = 3; // Adjust as needed
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

// Temporary storage for embed data
const tempEmbedData = {};

// Command createembed
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() || interaction.commandName !== 'tgc-createembed') return;

    const guildId = interaction.guild?.id;

    // Ensure the command is being used in a guild
    if (!guildId) {
        return interaction.reply({ content: 'This command can only be used in a server.', flags: 64 });
    }

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    ensureGuildSettings(guildId);

    // Step 1: Display Modal
    const modal = new ModalBuilder()
        .setCustomId('embedModal')
        .setTitle('Create an Embed');

    const authorInput = new TextInputBuilder()
        .setCustomId('embedTitle')
        .setLabel('Title Name')
        .setPlaceholder('Enter title name')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    const authorLinkInput = new TextInputBuilder()
        .setCustomId('embedTitleLink')
        .setLabel('Title Link (optional)')
        .setPlaceholder('Enter URL for title name')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    const descriptionInput = new TextInputBuilder()
        .setCustomId('embedDescription')
        .setLabel('Embed Description')
        .setPlaceholder('Enter the description of the embed')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

    const imageInput = new TextInputBuilder()
        .setCustomId('embedImage')
        .setLabel('Image URL (Optional)')
        .setPlaceholder('Enter a direct link to the image')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const thumbnailInput = new TextInputBuilder()
        .setCustomId('embedThumbnail')
        .setLabel('Thumbnail URL (optional)')
        .setPlaceholder('Enter a direct link to the thumbnail image')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(authorInput),
        new ActionRowBuilder().addComponents(authorLinkInput),
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(imageInput),
        new ActionRowBuilder().addComponents(thumbnailInput)
    );

    await interaction.showModal(modal);
});

// Step 2: Handle Modal Submission
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit() || interaction.customId !== 'embedModal') return;

    const title = interaction.fields.getTextInputValue('embedTitle')?.trim() || null;
    const titleLink = interaction.fields.getTextInputValue('embedTitleLink')?.trim() || null;
    const description = interaction.fields.getTextInputValue('embedDescription').trim();
    const imageUrl = interaction.fields.getTextInputValue('embedImage')?.trim();
    const thumbnailUrl = interaction.fields.getTextInputValue('embedThumbnail')?.trim();


    // Validate title and description
    if (!title || !description) {
        return interaction.reply({
            content: 'Both Title and Description are required. Please try again.',
            flags: 64
        });
    }

    // Store data in tempEmbedData
    tempEmbedData[interaction.user.id] = { 
        title, 
        titleLink, 
        description, 
        image: imageUrl, 
        thumbnail: thumbnailUrl 
    };

    // Proceed to color selection
    const colorOptions = [
        { label: 'Pink', value: '#eb0062' },
        { label: 'Red', value: '#ff0000' },
        { label: 'Dark Red', value: '#7c1e1e' },
        { label: 'Orange', value: '#ff4800' },
        { label: 'Yellow', value: '#ffe500' },
        { label: 'Green', value: '#1aff00' },
        { label: 'Forest Green', value: '#147839' },
        { label: 'Light Blue', value: '#00bdff' },
        { label: 'Dark Blue', value: '#356feb' },
        { label: 'Purple', value: '#76009a' },
    ];

    const colorMenu = new StringSelectMenuBuilder()
        .setCustomId('selectColor')
        .setPlaceholder('Choose a color for your embed')
        .addOptions(colorOptions);

    const colorRow = new ActionRowBuilder().addComponents(colorMenu);

    await interaction.reply({
        content: 'Select a color for your embed:',
        components: [colorRow],
        flags: 64
    });
});

// Step 3: Handle Color Selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'selectColor') return;

    const selectedColor = interaction.values[0]; // Selected hex color value
    const embedData = tempEmbedData[interaction.user.id];

    if (!embedData) {
        return interaction.update({
            content: '❌ No embed data found. Please restart the command.',
            components: [],
            flags: 64
        });
    }

    // Add color to embed data
    embedData.color = selectedColor;

    // Short delay to ensure Discord processes the defer before showing the modal
    setTimeout(async () => {
        try {
            // Prompt user to search for channels with a modal
            const modal = new ModalBuilder()
                .setCustomId('channelSearchModal')
                .setTitle('Search for Channels');

            const channelSearchInput = new TextInputBuilder()
                .setCustomId('channelSearch')
                .setLabel('Enter channel name or keyword')
                .setPlaceholder('e.g., general, updates')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const actionRow = new ActionRowBuilder().addComponents(channelSearchInput);
            modal.addComponents(actionRow);

            await interaction.showModal(modal);
        } catch (error) {
            console.error('Error displaying channel search modal:', error);
        }
    }, 500); // Delay to avoid interaction conflict
});

// Step 4: Handle Channel Search and Display Results
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit() || interaction.customId !== 'channelSearchModal') return;

    await interaction.deferReply({ flags: 64 }); // Prevents timeout issues

    const searchQuery = interaction.fields.getTextInputValue('channelSearch').trim().toLowerCase();
    const searchTerms = searchQuery.split(',').map((term) => term.trim()); // Split by comma and trim

    // Safely collect matching channels
    const matchingChannels = [];
    client.guilds.cache.forEach((guild) => {
        if (!guild.channels || !guild.channels.cache) return; // Ensure channels exist
        const textChannels = guild.channels.cache.filter((channel) =>
            channel.isTextBased() &&
            searchTerms.some((term) => channel.name.toLowerCase().includes(term)) // Match any search term
        );
        textChannels.forEach((channel) => {
            matchingChannels.push({
                label: `${guild.name} - #${channel.name}`,
                value: `${guild.id}:${channel.id}`,
            });
        });
    });

    // If no matching channels are found
    if (matchingChannels.length === 0) {
        return interaction.editReply({
            content: `❌ No matching channels found for **"${searchQuery}"**. Please try again with different keywords.`,
            components: []
        });
    }

    // Limit to the first 25 matching channels due to Discord's dropdown options limit
    const options = matchingChannels.slice(0, 25);

    const channelMenu = new StringSelectMenuBuilder()
        .setCustomId('selectChannels')
        .setPlaceholder('Select channels to send the embed')
        .setMinValues(1) // Minimum selection
        .setMaxValues(options.length) // Allow selecting all displayed options
        .addOptions(options);

    const channelRow = new ActionRowBuilder().addComponents(channelMenu);

    // Update the interaction with the dropdown menu
    await interaction.editReply({
        content: '✅ Select one or more channels from the list below:',
        components: [channelRow]
    });
});

// Step 5: Handle Channel Selection and Send Embed
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'selectChannels') return;

    const selectedChannelIds = interaction.values; // Array of selected channel IDs
    const embedData = tempEmbedData[interaction.user.id];

    if (!embedData || selectedChannelIds.length === 0) {
        return interaction.update({
            content: '❌ No embed data or channels selected. Please restart the command.',
            components: [],
        });
    }

    // Build the final embed
    const embed = new EmbedBuilder()
        .setDescription(embedData.description)
        .setColor(embedData.color);

    if (embedData.title) {
        embed.setTitle(embedData.title);
        if (embedData.titleLink) {
            embed.setURL(embedData.titleLink);
        }
    }

    if (embedData.thumbnail) {
        embed.setThumbnail(embedData.thumbnail);
    }

    if (embedData.image) {
        embed.setImage(embedData.image);
    }

    // If there is a title link, create a button to match
    const components = [];
    if (embedData.titleLink) {
        const linkButton = new ButtonBuilder()
            .setLabel('🔗 View More') // Button text
            .setStyle(ButtonStyle.Link) // Link button style
            .setURL(embedData.titleLink); // Link URL

        const buttonRow = new ActionRowBuilder().addComponents(linkButton);
        components.push(buttonRow);
    }

    // Send the embed to all selected channels
    let successfulSends = 0;
    let failedSends = 0;

    for (const value of selectedChannelIds) {
        const [guildId, channelId] = value.split(':');
        const guild = client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(channelId);

        if (!channel || !channel.isTextBased()) {
            console.error(`Channel not found or not text-based: ${guildId}:${channelId}`);
            failedSends++;
            continue;
        }

        try {
            await channel.send({ embeds: [embed], components: components.length ? components : undefined });
            successfulSends++;
        } catch (error) {
            console.error(`Failed to send embed to ${guild.name} #${channel.name}:`, error);
            failedSends++;
        }
    }

    delete tempEmbedData[interaction.user.id]; // Clean up temporary data

    // Respond to the user with a summary of the operation
    await interaction.update({
        content: `✅ **Embed sent successfully to ${successfulSends} channels.**\n❌ **Failed to send to ${failedSends} channels.**`,
        components: [],
    });
});

// Ban Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "tgc-ban") return;

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

    const target = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const duration = interaction.options.getInteger("duration"); // in days

    if (!target) {
        return interaction.reply({
            content: "Please specify a user to ban.",
            flags: 64
        });
    }

    try {
        // Calculate expiration time if a duration is specified
        const expiresAt = duration ? Date.now() + duration * 24 * 60 * 60 * 1000 : null;

        // Check if the user is already banned in the database
        const existingBan = db.prepare('SELECT * FROM global_bans WHERE user_id = ?').get(target.id);

        if (existingBan) {
            return interaction.reply({
                content: `${target.tag} is already globally banned.`,
                flags: 64
            });
        }

        // Store the ban in the database
        db.prepare(`
            INSERT INTO global_bans (user_id, reason, expires_at)
            VALUES (?, ?, ?)
        `).run(target.id, reason, expiresAt);

        // Apply the global ban across all servers
        const results = [];
        for (const [guildId, guild] of client.guilds.cache) {
            try {
                await guild.members.ban(target.id, { reason });
                results.push(`✅ Banned in **${guild.name}**`);
            } catch (error) {
                console.error(`Failed to ban in guild ${guild.name}:`, error);
                results.push(`❌ Failed to ban in **${guild.name}**`);
            }
        }

        // Respond with ban confirmation and affected servers
        interaction.reply({
            content: `**${target.tag}** has been globally banned.${duration ? ` Ban duration: ${duration} days.` : ""}\n\n${results.join("\n")}`,
        });
    } catch (error) {
        console.error("Error banning user:", error);
        interaction.reply({
            content: `An error occurred while banning ${target.tag}: ${error.message}`,
            flags: 64
        });
    }
});

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

    try {
        // Synchronize bans before displaying them
        await synchronizeBans();

        // Fetch bans from the database
        const bans = db.prepare('SELECT * FROM global_bans').all();

        if (!bans.length) {
            return interaction.reply({
                content: 'No users are currently banned.',
                flags: 64
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

        // Reply with the first message and follow up with the rest
        await interaction.reply({ content: banChunks.shift(), flags: 64 });

        for (const chunk of banChunks) {
            await interaction.followUp({ content: chunk, flags: 64 });
        }
    } catch (error) {
        console.error('Error fetching ban list:', error);
        return interaction.reply({
            content: 'An error occurred while fetching the ban list.',
            flags: 64
        });
    }
});

// unban Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'tgc-unban') return;

    // Permission Check
    if (!checkCommandPermission(interaction)) {
        return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: 64
        });
    }

    try {
        // Synchronize bans with the database
        await synchronizeBans();

        // Fetch updated bans from the database
        const bans = db.prepare('SELECT * FROM global_bans').all();

        if (!bans.length) {
            return interaction.reply({
                content: 'There are no users currently banned.',
                flags: 64
            });
        }

        // Split bans into pages of 25
        const MAX_OPTIONS = 25;
        const totalPages = Math.ceil(bans.length / MAX_OPTIONS);
        let currentPage = 0;

        // Function to generate options for the dropdown
        const generateOptions = (page) => {
            return bans.slice(page * MAX_OPTIONS, (page + 1) * MAX_OPTIONS).map((ban) => {
                return {
                    label: `User ID: ${ban.user_id}`, // Display user ID (Fetch username later)
                    description: ban.expires_at
                        ? `Expires: <t:${Math.floor(ban.expires_at / 1000)}:R>`
                        : 'Permanent Ban',
                    value: ban.user_id
                };
            });
        };

        // Create the dropdown menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`selectUnbanUser_${currentPage}`)
            .setPlaceholder('Select a user to unban')
            .addOptions(generateOptions(currentPage));

        // Add "Next Page" button if there are multiple pages
        const components = [new ActionRowBuilder().addComponents(selectMenu)];
        if (totalPages > 1) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('nextPage')
                    .setLabel('Next Page ➡️')
                    .setStyle(ButtonStyle.Primary)
            ));
        }

        return interaction.reply({
            content: `Select a user from the list to unban: (Page **${currentPage + 1}** of **${totalPages}**)`,
            components,
            flags: 64
        });

    } catch (error) {
        console.error('Error fetching unban list:', error);
        return interaction.reply({
            content: 'An error occurred while fetching the ban list.',
            flags: 64
        });
    }
});

// Handle dropdown selection for unban with user confirmation & per-guild results
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('selectUnbanUser')) return;

    const userId = interaction.values[0]; // Selected user ID

    try {
        // Attempt to fetch the user's details from Discord
        let user;
        try {
            user = await client.users.fetch(userId);
        } catch (fetchError) {
            console.warn(`Could not fetch user ${userId}, using ID instead.`);
        }

        // Remove the user from the database
        db.prepare('DELETE FROM global_bans WHERE user_id = ?').run(userId);

        // Attempt to unban the user from all guilds
        let unbanResults = [];
        for (const [guildId, guild] of client.guilds.cache) {
            try {
                await guild.bans.remove(userId, 'Unbanned via dropdown menu');
                unbanResults.push(`✅ Unbanned from: **${guild.name}**`);
            } catch (error) {
                console.error(`Failed to unban user ${userId} in guild ${guild.name}:`, error);
                unbanResults.push(`❌ Failed to unban from: **${guild.name}**`);
            }
        }

        // Get the user's name or fallback to ID
        const userTag = user ? `${user.tag} (ID: ${user.id})` : `Unknown User (ID: ${userId})`;

        // Send confirmation with user details
        return interaction.update({
            content: `**${userTag}** has been unbanned.\n\n${unbanResults.join('\n')}`,
            components: [],
        });
    } catch (error) {
        console.error('Error during unban:', error);

        // Handle unknown users or errors
        return interaction.update({
            content: `An error occurred while unbanning the user with ID: ${userId}.`,
            components: [],
        });
    }
});

// Handle pagination for the dropdown
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || interaction.customId !== 'nextPage') return;

    try {
        let currentPage = parseInt(interaction.message.content.match(/\d+/g)[0]) - 1; // Extract current page
        currentPage++;

        const bans = db.prepare('SELECT * FROM global_bans').all();
        const MAX_OPTIONS = 25;
        const totalPages = Math.ceil(bans.length / MAX_OPTIONS);

        if (currentPage >= totalPages) {
            return interaction.reply({
                content: 'No more pages available.',
                flags: 64
            });
        }

        // Generate new options
        const newOptions = bans.slice(currentPage * MAX_OPTIONS, (currentPage + 1) * MAX_OPTIONS).map((ban) => {
            return {
                label: `User ID: ${ban.user_id}`,
                description: ban.expires_at
                    ? `Expires: <t:${Math.floor(ban.expires_at / 1000)}:R>`
                    : 'Permanent Ban',
                value: ban.user_id
            };
        });

        // Create new dropdown menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`selectUnbanUser_${currentPage}`)
            .setPlaceholder('Select a user to unban')
            .addOptions(newOptions);

        // Add "Next Page" button if there are more pages
        const components = [new ActionRowBuilder().addComponents(selectMenu)];
        if (currentPage < totalPages - 1) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('nextPage')
                    .setLabel('Next Page ➡️')
                    .setStyle(ButtonStyle.Primary)
            ));
        }

        return interaction.update({
            content: `Select a user from the list to unban: (Page **${currentPage + 1}** of **${totalPages}**)`,
            components
        });

    } catch (error) {
        console.error('Error handling pagination:', error);
        return interaction.reply({
            content: 'An error occurred while fetching the next page.',
            flags: 64
        });
    }
});

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

        const action = options.getString("action"); // "add" or "remove"
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
                    INSERT INTO command_roles (guild_id, role_id)
                    VALUES (?, ?)
                    ON CONFLICT DO NOTHING
                `).run(guildId, role.id);

                await interaction.reply({
                    content: `Role **${role.name}** has been added to the command roles list.`,
                    flags: 64
                });
            } else if (action === "remove") {
                // Remove role from the command_roles table
                const changes = db.prepare(`
                    DELETE FROM command_roles WHERE guild_id = ? AND role_id = ?
                `).run(guildId, role.id);

                if (changes.changes === 0) {
                    return interaction.reply({
                        content: `Role **${role.name}** was not found in the command roles list.`,
                        flags: 64
                    });
                }

                await interaction.reply({
                    content: `Role **${role.name}** has been removed from the command roles list.`,
                    flags: 64
                });
            } else {
                // Invalid action
                await interaction.reply({
                    content: "Invalid action. Use 'add' or 'remove'.",
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
    const categoryName = selectedCategory ? `Report-${selectedCategory}` : selectedType;

    // Define channel name
    const channelName = `${categoryName}-${user.username}`;

    try {
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                {
                    id: user.id,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                }
            ]
        });

        await interaction.reply({
            content: `Ticket created: <#${channel.id}>`,
            flags: 64
        });

        await channel.send({
            content: `Hello ${user}, please describe your issue or report.`,
        });

    } catch (error) {
        console.error("Error creating ticket channel:", error);
        await interaction.reply({
            content: "There was an error creating your ticket. Please try again later.",
            flags: 64
        });
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
                let winnerName = hp1 > 0 ? fighter1Name : fighter2Name;

                // Reward system: Random bolts between 100-500
                const minBolts = 50;
                const maxBolts = 20;
                const reward = Math.floor(Math.random() * (maxBolts - minBolts + 1)) + minBolts;

                // Update currency balance
                shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(reward, winner.id);

                // Get winner's server avatar (fallback to global avatar)
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
                        { name: "⚙️ Reward:", value: ` **${reward}** Bolts!` }
                    )
                    .setThumbnail(winnerAvatar)
                    .setFooter({ text: "Who will battle next?" })
                    .setImage ("https://media1.tenor.com/m/_wtKfUXAfLUAAAAd/ratchet-and.gif");

                return interaction.editReply({ embeds: [battleEmbed] });
            }

            let attacker = turn === 1 ? fighter1Name : fighter2Name;
            let defender = turn === 1 ? fighter2Name : fighter1Name;
            let damage = Math.floor(Math.random() * 20) + 5; // Random damage 5-25
            let crit = Math.random() < 0.15; // 15% chance for a critical hit

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
                setTimeout(battleTurn, 2000); // Delay for next turn
            } else {
                setTimeout(battleTurn, 4000); // Slightly longer delay for final blow
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

    const itemId = parseInt(interaction.values[0]);
    const item = shopDB.prepare("SELECT * FROM shop_items WHERE item_id = ?").get(itemId);
    if (!item) {
        return interaction.reply({ content: "❌ This item no longer exists.", flags: 64 });
    }

    const confirmButton = new ButtonBuilder()
        .setCustomId(`confirm_purchase_${itemId}`)
        .setLabel("Confirm Purchase")
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

// Confirm Purchase
client.on("interactionCreate", async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("confirm_purchase_")) return;

    const itemId = parseInt(interaction.customId.replace("confirm_purchase_", ""));
    const userId = interaction.user.id;

    const item = shopDB.prepare("SELECT * FROM shop_items WHERE item_id = ?").get(itemId);
    if (!item) {
        return interaction.reply({ content: "❌ This item is no longer available.", flags: 64 });
    }

    let userData = shopDB.prepare("SELECT balance FROM user_currency WHERE user_id = ?").get(userId);
    if (!userData) {
        shopDB.prepare("INSERT INTO user_currency (user_id, balance) VALUES (?, ?)").run(userId, 0);
        userData = { balance: 0 };
    }

    if (userData.balance < item.price) {
        return interaction.reply({ content: `❌ Not enough currency!`, flags: 64 });
    }

    shopDB.prepare("UPDATE user_currency SET balance = balance - ? WHERE user_id = ?").run(item.price, userId);
    shopDB.prepare("INSERT INTO user_inventory (user_id, item_id) VALUES (?, ?)").run(userId, itemId);

    return interaction.reply({
        content: `✅ Purchased **${item.name}** for **${item.price} 💰!**`,
        flags: 64
    });
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
        checkJackpotWin(userId);

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
    checkJackpotWin(userId);

    // Embed result
    const rouletteEmbed = new EmbedBuilder()
        .setTitle("🎡 Roulette Spin!")
        .setDescription(`🎲 Winning Number: **${winningNumber}** (${winningColor.toUpperCase()})`)
        .setColor(winnings > 0 ? "#00FF00" : "#FF0000")
        .setFooter({ text: winnings > 0 ? `You won ⚙️ ${winnings}!` : "Better luck next time!" });

    return interaction.reply({ embeds: [rouletteEmbed]});
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
function announceJackpotWin(userId, amount) {
    shopDB.prepare("UPDATE user_currency SET balance = balance + ? WHERE user_id = ?").run(amount, userId);
    
    const user = client.users.cache.get(userId);
    if (user) {
        user.send(`🎉 Congratulations! You won the jackpot of **⚙️ ${amount}** bolts! 🎰`);
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
    const xpGain = parseFloat((Math.random() * (5 - 1) + 1).toFixed(2));

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

// Bot Ready

// Run synchronization every 5 minutes
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await synchronizeBans(); // Run the sync on startup
});
setInterval(async () => {
    await synchronizeBans();
}, 5 * 60 * 1000); // 5 minutes

client.on('ready', () => {
    console.log('Bot is ready!');
    console.log(`Available Guilds: ${client.guilds.cache.size}`);

    client.guilds.cache.forEach((guild) => {
        console.log(`Guild: ${guild.name} (ID: ${guild.id})`);
    });
});

// Start Bot
client.login(process.env.TOKEN);
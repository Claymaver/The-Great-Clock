const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions
    ]
});

const tempEmbedData = {};

const Database = require('better-sqlite3');
require('dotenv').config();

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
        multiplier REAL DEFAULT 1.11
    );

`);

// Ensure schema is updated
try {
    db.prepare(`SELECT multiplier FROM guild_settings LIMIT 1`).get();
} catch (error) {
    console.log("Updating schema: Adding 'multiplier' column to 'guild_settings'.");
    db.exec(`ALTER TABLE guild_settings ADD COLUMN multiplier REAL DEFAULT 1.11`);
}

// Ensure Guild Settings
function ensureGuildSettings() {
    db.prepare(`
        INSERT INTO guild_settings (guild_id, base_xp, multiplier)
        VALUES ('global', 300, 1.11)
        ON CONFLICT(guild_id) DO NOTHING
    `).run();
}

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

// Calculate XP required for a specific level
function calculateTotalXpForLevel(level, baseXp, multiplier) {
    let totalXp = 0;

    for (let i = 1; i < level; i++) {
        totalXp += baseXp * Math.pow(multiplier, i - 1); // XP for each level
    }

    return totalXp;
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Register Commands
const commands = [
    new SlashCommandBuilder()
        .setName('setbasexp')
        .setDescription('Set the base XP value for leveling.')
        .addIntegerOption(option =>
            option.setName('value')
                .setDescription('The new base XP value.')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('setmultiplier')
        .setDescription('Set the XP multiplier for leveling.')
        .addNumberOption(option =>
            option.setName('value')
                .setDescription('The multiplier (defualt 1.11.')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('setlevelrole')
        .setDescription('Set a role to be applied when a user reaches a specific level.')
        .addIntegerOption(option =>
            option.setName('level')
                .setDescription('The level at which the role will be applied.')
                .setRequired(true))
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('The role to assign.')
                .setRequired(true)),
                new SlashCommandBuilder()
                .setName('setxp')
                .setDescription('Set a user\'s global XP or level manually.')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('The user whose global XP or level you want to set.')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('xp')
                        .setDescription('The global XP amount to set.'))
                .addIntegerOption(option =>
                    option.setName('level')
                        .setDescription('The level to set (overrides XP).')),
            
    new SlashCommandBuilder()
        .setName('importuserdata')
        .setDescription('Import user data from a JSON file to update XP.')
        .addAttachmentOption(option =>
            option.setName('file')
                .setDescription('The JSON file to import user data from.')
                .setRequired(true)),
                new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View your profile or another user\'s profile.')
    .addUserOption(option =>
        option.setName('user')
            .setDescription('The user whose profile you want to view.')
            .setRequired(false)),
            new SlashCommandBuilder()
        .setName('sendembed')
        .setDescription('Create and send an embed to multiple servers and channels.')

];

(async () => {
    try {
        console.log('Registering commands...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands.map(command => command.toJSON()) }
        );
        console.log('Commands registered successfully.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
})();

// Function to generate progress bar
function generateProgressBar(currentXp, xpForNextLevel, barLength = 20) {
    const progress = Math.max(0, Math.min(currentXp / xpForNextLevel, 1)); // Ensure progress is between 0 and 1
    const filledLength = Math.floor(progress * barLength);
    const emptyLength = barLength - filledLength;

    return '█'.repeat(filledLength) + '░'.repeat(emptyLength); // Create the progress bar
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    const guildId = interaction.guild?.id;

    if (commandName === 'setbasexp') {
        const baseXp = interaction.options.getInteger('value');
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
            await interaction.reply({ content: 'Failed to update Base XP.', flags: 64 });
        }
    }

    if (commandName === 'setmultiplier') {
        const multiplier = interaction.options.getNumber('value');
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
            await interaction.reply({ content: 'Failed to update multiplier.', flags: 64 });
        }
    }

    if (commandName === 'setxp') {
        const user = interaction.options.getUser('user');
        const xp = interaction.options.getInteger('xp');
        const level = interaction.options.getInteger('level');
    
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
                flags: 64,
            });
        }
    }

    if (commandName === 'setlevelrole') {
        const level = interaction.options.getInteger('level');
        const role = interaction.options.getRole('role');

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
            await interaction.reply({ content: 'Failed to set level role.', flags: 64 });
        }
    }

    if (commandName === 'importuserdata') {
        const fileAttachment = interaction.options.getAttachment('file');
    
        if (!fileAttachment || !fileAttachment.name.endsWith('.json')) {
            return interaction.reply({
                content: 'Please upload a valid JSON file.',
                flags: 64,
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
            `).get() || { base_xp: 300, multiplier: 1.11 };
    
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
    
    if (commandName === 'profile') {
        const user = interaction.options.getUser('user') || interaction.user;
    
        try {
            // Fetch user XP globally
            const { xp: totalXp } = db.prepare(`
                SELECT xp FROM user_xp WHERE user_id = ?
            `).get(user.id) || { xp: 0 };
    
            // Fetch global base XP and multiplier
            const { base_xp: baseXp, multiplier } = db.prepare(`
                SELECT base_xp, multiplier FROM guild_settings WHERE guild_id = 'global'
            `).get() || { base_xp: 300, multiplier: 1.11 };
    
            // Handle cases where total XP exceeds the expected range for the current level
            let level = calculateLevel(totalXp, baseXp, multiplier);
            let xpForCurrentLevel = calculateTotalXpForLevel(level, baseXp, multiplier);
            let xpForNextLevel = calculateTotalXpForLevel(level + 1, baseXp, multiplier);
    
            while (totalXp >= xpForNextLevel) {
                level++;
                xpForCurrentLevel = xpForNextLevel;
                xpForNextLevel = calculateTotalXpForLevel(level + 1, baseXp, multiplier);
            }
    
            // Calculate XP progress
            const xpProgress = Math.max(0, totalXp - xpForCurrentLevel);
            const xpRequired = Math.max(1, xpForNextLevel - xpForCurrentLevel); // Prevent divide-by-zero errors
    
            // Progress bar logic
            const progressBarLength = 20;
            const progressRatio = Math.min(1, xpProgress / xpRequired); // Clamp progress ratio to [0, 1]
            const progressBarFilled = Math.round(progressRatio * progressBarLength);
            const progressBar = '█'.repeat(progressBarFilled) + '░'.repeat(progressBarLength - progressBarFilled);
    
            // Estimate messages to next level
            const averageXpPerMessage = 3; // Adjust based on your XP gain range
            const messagesToNextLevel = Math.max(0, Math.ceil((xpRequired - xpProgress) / averageXpPerMessage));
    
            // Debug logs
            console.log(`User: ${user.username}`);
            console.log(`Total XP: ${totalXp}`);
            console.log(`Level: ${level}`);
            console.log(`XP for Current Level: ${xpForCurrentLevel}`);
            console.log(`XP for Next Level: ${xpForNextLevel}`);
            console.log(`XP Progress: ${xpProgress}`);
            console.log(`Progress Ratio: ${progressRatio}`);
            console.log(`Progress Bar: ${progressBar}`);
            console.log(`Messages to Next Level: ${messagesToNextLevel}`);
    
            // Create embed
            const profileEmbed = new EmbedBuilder()
                .setTitle(`${user.username}'s Profile`)
                .setDescription(`Level: **${level}**\nTotal XP: **${totalXp.toFixed(2)}**`)
                .addFields(
                    { name: 'Progress to Next Level', value: `${progressBar} (${xpProgress.toFixed(2)} / ${xpRequired.toFixed(2)} XP)` },
                    { name: 'Messages to Next Level', value: `${messagesToNextLevel} (approx)` }
                )
                .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                .setColor('#00FF00');
    
            await interaction.reply({ embeds: [profileEmbed] });
        } catch (error) {
            console.error('Error generating profile:', error);
            await interaction.reply({
                content: 'An error occurred while generating the profile. Please try again later.',
                flags: 64,
            });
        }
    } 
});

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
    `).get() || { base_xp: 300, multiplier: 1.11 };

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

// Embed creation command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() || interaction.commandName !== 'sendembed') return;

    // Step 1: Show a modal to gather embed details
    const modal = new ModalBuilder()
        .setCustomId('embedModal')
        .setTitle('Create an Embed');

    const titleInput = new TextInputBuilder()
        .setCustomId('embedTitle')
        .setLabel('Embed Title')
        .setPlaceholder('Enter the title of the embed')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const descriptionInput = new TextInputBuilder()
        .setCustomId('embedDescription')
        .setLabel('Embed Description')
        .setPlaceholder('Enter the description of the embed')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

    const colorInput = new TextInputBuilder()
        .setCustomId('embedColor')
        .setLabel('Embed Color')
        .setPlaceholder('Enter a hex color code (e.g., #00FF00)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const titleRow = new ActionRowBuilder().addComponents(titleInput);
    const descriptionRow = new ActionRowBuilder().addComponents(descriptionInput);
    const colorRow = new ActionRowBuilder().addComponents(colorInput);

    modal.addComponents(titleRow, descriptionRow, colorRow);

    await interaction.showModal(modal);
});

// Handle modal submission
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit() || interaction.customId !== 'embedModal') return;

    const embedTitle = interaction.fields.getTextInputValue('embedTitle');
    const embedDescription = interaction.fields.getTextInputValue('embedDescription');
    const embedColor = interaction.fields.getTextInputValue('embedColor') || '#00FF00';

    const embed = new EmbedBuilder()
        .setTitle(embedTitle)
        .setDescription(embedDescription)
        .setColor(embedColor);

    tempEmbedData[interaction.user.id] = embed;

    // Step 2: Present a list of servers to choose from
    const guildOptions = client.guilds.cache.map((guild) => ({
        label: guild.name,
        value: guild.id
    }));

    const guildSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('selectGuild')
        .setPlaceholder('Select servers')
        .setMinValues(1)
        .setMaxValues(guildOptions.length)
        .addOptions(guildOptions);

    const guildRow = new ActionRowBuilder().addComponents(guildSelectMenu);

    await interaction.reply({
        content: 'Select servers to send the embed:',
        components: [guildRow],
        flags: 64
    });
});

// Store selected channels temporarily
const tempChannelSelections = {};

// Handle server selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'selectGuild') return;

    const selectedGuildIds = interaction.values;

    // Fetch all text-based channels in the selected servers
    const channelOptions = selectedGuildIds.flatMap((guildId) => {
        const guild = client.guilds.cache.get(guildId);
        return guild.channels.cache
            .filter((channel) => channel.isTextBased())
            .map((channel) => ({
                label: `${guild.name} - #${channel.name}`,
                value: `${guildId}:${channel.id}`
            }));
    });

    if (channelOptions.length === 0) {
        return interaction.update({
            content: 'No text channels found in the selected servers.',
            components: [],
            flags: 64
        });
    }

    // Split options into chunks of 25 to adhere to Discord's limit
    const chunkedOptions = [];
    for (let i = 0; i < channelOptions.length; i += 25) {
        chunkedOptions.push(channelOptions.slice(i, i + 25));
    }

    const components = chunkedOptions.map((options, index) =>
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`selectChannel_${index}`)
                .setPlaceholder(`Select channels (Page ${index + 1})`)
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options)
        )
    );

    // Add a Submit button
    components.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('submitEmbed')
                .setLabel('Submit')
                .setStyle(ButtonStyle.Success)
        )
    );
    

    tempChannelSelections[interaction.user.id] = []; // Initialize empty selections for the user

    await interaction.update({
        content: 'Select channels to send the embed (max 25 per menu):',
        components,
        flags: 64
    });
});

// Handle channel selection
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('selectChannel_')) return;

    const selectedChannels = interaction.values.map((value) => {
        const [guildId, channelId] = value.split(':');
        return { guildId, channelId };
    });

    // Store selected channels
    if (!tempChannelSelections[interaction.user.id]) {
        tempChannelSelections[interaction.user.id] = [];
    }
    tempChannelSelections[interaction.user.id].push(...selectedChannels);

    await interaction.update({
        content: 'Channels selected! You can select more or click **Submit** to send the embed.',
        components: interaction.message.components, // Keep the components for additional selection
        flags: 64
    });
});

// Handle embed submission
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || interaction.customId !== 'submitEmbed') return;

    const selectedChannels = tempChannelSelections[interaction.user.id];
    if (!selectedChannels || selectedChannels.length === 0) {
        return interaction.reply({
            content: 'No channels selected. Please select at least one channel before submitting.',
            flags: 64
        });
    }

    const embed = tempEmbedData[interaction.user.id];
    if (!embed) {
        return interaction.reply({
            content: 'No embed found to send. Please try again.',
            flags: 64
        });
    }

    // Send embed to all selected channels
    for (const { guildId, channelId } of selectedChannels) {
        const guild = client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(channelId);

        if (channel) {
            await channel.send({ embeds: [embed] }).catch(console.error);
        }
    }

    delete tempEmbedData[interaction.user.id];
    delete tempChannelSelections[interaction.user.id];

    await interaction.update({
        content: 'Embed sent successfully to the selected channels!',
        components: [], // Remove components after submission
        flags: 64
    });
});

// Bot Ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Start Bot
client.login(process.env.TOKEN);
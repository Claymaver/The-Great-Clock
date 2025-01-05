const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { scheduleJob } = require('node-schedule');

const TOKEN = '1234';
const CLIENT_ID = '123';

const rest = new REST({ version: '10' }).setToken(TOKEN);

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('leveling.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the leveling database.');
});

// Create the tables with the correct schema
db.run(`CREATE TABLE IF NOT EXISTS user_xp (
  user_id INTEGER NOT NULL,
  guild_id INTEGER NOT NULL,
  xp REAL DEFAULT 0,
  PRIMARY KEY (user_id, guild_id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id INTEGER PRIMARY KEY,
    base_xp INTEGER DEFAULT 100,
    formula TEXT DEFAULT 'linear',
    cooldown INTEGER DEFAULT 60
)`);

db.run(`CREATE TABLE IF NOT EXISTS level_roles (
  level INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  guild_id INTEGER NOT NULL,
  PRIMARY KEY (level, guild_id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS user_activity (
    user_id INTEGER NOT NULL,
    guild_id INTEGER NOT NULL,
    last_xp_time INTEGER,
    PRIMARY KEY (user_id, guild_id)
)`);

// Alter existing tables if necessary
db.run(`ALTER TABLE user_xp ADD COLUMN guild_id INTEGER`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding guild_id column to user_xp:', err.message);
  }
});

db.run(`ALTER TABLE level_roles ADD COLUMN guild_id INTEGER`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding guild_id column to level_roles:', err.message);
  }
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const commands = [
  {
      name: 'profile',
      description: 'View your current level and XP progress',
  },
  {
    name: 'setxp',
    description: 'Set a user\'s XP or level manually.',
    options: [
        {
            type: 6, // USER
            name: 'user',
            description: 'The user to set XP or level for',
            required: true,
        },
        {
            type: 4, // INTEGER
            name: 'xp',
            description: 'The amount of XP to set',
            required: false,
        },
        {
            type: 4, // INTEGER
            name: 'level',
            description: 'The level to set (XP will be calculated)',
            required: false,

          },
      ],
  },
  {
      name: 'setlevelrole',
      description: 'Set a role to be applied when a user reaches a specific level.',
      options: [
          {
              type: 4, // INTEGER
              name: 'level',
              description: 'The level at which the role will be applied.',
              required: true,
          },
          {
              type: 8, // ROLE
              name: 'role',
              description: 'The role to apply at the specified level.',
              required: true,
          },
      ],
  },
  {
      name: 'settings',
      description: 'View or update XP settings.',
      options: [
          {
              type: 1, // SUB_COMMAND
              name: 'view',
              description: 'View the current XP settings.',
          },
          {
              type: 1, // SUB_COMMAND
              name: 'update',
              description: 'Update XP settings.',
              options: [
                  {
                      type: 4, // INTEGER
                      name: 'base_xp',
                      description: 'Base XP required for leveling',
                      required: true,
                  },
                  {
                      type: 4, // INTEGER
                      name: 'cooldown',
                      description: 'Cooldown time in seconds',
                      required: true,
                  },
              ],
          },
      ],
  },
];

(async () => {
  try {
      console.log('Refreshing application commands...');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Successfully registered application commands.');
  } catch (error) {
      console.error('Error registering application commands:', error);
  }
})();

function calculateLevel(xp, baseXp = 100) {
  return Math.floor(Math.sqrt(xp / baseXp));
}

function canEarnXp(userId, guildId) {
  return new Promise((resolve) => {
      const currentTime = Math.floor(Date.now() / 1000);

      db.get(
          `SELECT user_activity.last_xp_time, guild_settings.cooldown
           FROM user_activity
           LEFT JOIN guild_settings ON guild_settings.guild_id = user_activity.guild_id
           WHERE user_activity.user_id = ? AND user_activity.guild_id = ?`,
          [userId, guildId],
          (err, row) => {
              if (err) {
                  console.error(`Error in canEarnXp query:`, err);
                  return resolve(false);
              }
              if (row && row.last_xp_time && row.cooldown) {
                  resolve(currentTime - row.last_xp_time >= row.cooldown);
              } else {
                  resolve(true);
              }
          }
      );
  });
}

function updateUserXp(userId, guildId, xpGain) {
  return new Promise((resolve) => {
      db.run(
          `INSERT INTO user_xp (user_id, guild_id, xp)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, guild_id) DO UPDATE SET xp = xp + excluded.xp`,
          [userId, guildId, xpGain],
          (err) => {
              if (err) {
                  console.error(`Error updating XP for user ${userId} in guild ${guildId}:`, err);
                  return resolve(0);
              }
              db.get(
                  `SELECT xp FROM user_xp WHERE user_id = ? AND guild_id = ?`,
                  [userId, guildId],
                  (err, row) => {
                      if (err) {
                          console.error(`Error fetching XP for user ${userId} in guild ${guildId}:`, err);
                          return resolve(0);
                      }
                      resolve(row ? row.xp : 0);
                  }
              );
          }
      );
  });
}

function updateLastXpTime(userId, guildId) {
  if (!guildId) {
      console.error(`updateLastXpTime called with undefined guildId for user ${userId}`);
      return;
  }

  const currentTime = Math.floor(Date.now() / 1000);

  db.run(
      `INSERT INTO user_activity (user_id, guild_id, last_xp_time)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, guild_id) DO UPDATE SET last_xp_time = excluded.last_xp_time`,
      [userId, guildId, currentTime],
      (err) => {
          if (err) {
              console.error(`Error updating last XP time for user ${userId} in guild ${guildId}:`, err);
          } else {
              console.log(`Updated last XP time for user ${userId} in guild ${guildId}.`);
          }
      }
  );
}

async function assignRoles(member, level, guild) {
  try {
      const roles = await new Promise((resolve, reject) => {
          db.all(
              `SELECT level, role_id FROM level_roles WHERE guild_id = ? ORDER BY level ASC`,
              [guild.id],
              (err, rows) => {
                  if (err) {
                      reject(err);
                  } else {
                      resolve(rows);
                  }
              }
          );
      });

      console.log(`Roles fetched from the database for guild '${guild.name}':`);
      roles.forEach(({ level: lvl, role_id }) => {
          console.log(`Level: ${lvl}, Role ID: ${role_id}`);
      });

      const rolesToRemove = [];
      let highestRole = null;

      // Determine which roles to remove and the highest role to assign
      roles.forEach(({ level: requiredLevel, role_id }) => {
          const role = guild.roles.cache.get(role_id);
          if (role) {
              if (level >= requiredLevel) {
                  highestRole = role; // Highest role the user qualifies for
              } else {
                  rolesToRemove.push(role); // Roles higher than the user's level
              }
          } else {
              console.warn(
                  `Role with ID ${role_id} does not exist in the guild '${guild.name}'.`
              );
          }
      });

      // Remove roles no longer applicable
      for (const role of member.roles.cache.values()) {
          if (rolesToRemove.includes(role)) {
              await member.roles.remove(role);
              console.log(`Removed role '${role.name}' from ${member.displayName}.`);
          }
      }

      // Assign the highest qualifying role
      if (highestRole && !member.roles.cache.has(highestRole.id)) {
          await member.roles.add(highestRole);
          console.log(
              `Assigned role '${highestRole.name}' to ${member.displayName} for reaching level ${level}.`
          );
      } else if (!highestRole) {
          console.log(`No valid roles found for level ${level} in guild '${guild.name}'.`);
      } else {
          console.log(`No new role to assign for ${member.displayName}.`);
      }
  } catch (error) {
      console.error(
          `Error assigning roles for ${member.displayName} in guild '${guild.name}':`,
          error
      );
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const commandName = interaction.commandName;

  if (commandName === 'profile') {
      const userId = interaction.user.id;

      db.get(`SELECT xp FROM user_xp WHERE user_id = ?`, [userId], (err, row) => {
          if (err) {
              console.error(`Error fetching XP for user ${userId}:`, err);
              const embed = new EmbedBuilder()
                  .setTitle('Error 🚫')
                  .setDescription('An error occurred while fetching your profile. Please try again later.')
                  .setColor('#FF0000')
                  .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
              interaction.reply({ embeds: [embed] });
              return;
          }

          if (!row) {
              const embed = new EmbedBuilder()
                  .setTitle('No Data 📊')
                  .setDescription('You haven’t earned any XP yet. Start participating to earn XP!')
                  .setColor('#FFA500')
                  .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
              interaction.reply({ embeds: [embed] });
              return;
          }

          const xp = parseFloat(row.xp.toFixed(2)); // Round XP to two decimal places
          const level = calculateLevel(xp);
          const baseXp = 100; // Default XP required for level-up, or fetch from DB if configurable.
          const nextLevelXp = Math.pow(level + 1, 2) * baseXp;
          const currentLevelXp = Math.pow(level, 2) * baseXp;
          const progress = xp - currentLevelXp;
          const progressPercentage = Math.floor((progress / (nextLevelXp - currentLevelXp)) * 100);

          const xpNeededForNextLevel = (nextLevelXp - xp).toFixed(2);

          // XP per message is assumed to be between 1 and 5 (inclusive)
          const avgXpPerMessage = 3; // Average XP per message
          const messagesNeeded = Math.ceil((nextLevelXp - xp) / avgXpPerMessage);

          // Create a progress bar
          const progressBar = createProgressBar(progressPercentage);

          const embed = new EmbedBuilder()
              .setTitle(`${interaction.user.username}'s Profile 🧾`)
              .setDescription(
                  `**Level:** ${level}\n` +
                  `**XP:** ${xp} / ${nextLevelXp.toFixed(2)}\n\n` +
                  `**Progress:**\n${progressBar} (${progressPercentage}%)\n\n` +
                  `**XP to Next Level:** ${xpNeededForNextLevel}\n` +
                  `**Estimated Messages Needed:** ~${messagesNeeded}`
              )
              .setColor('#3498DB')
              .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
              .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });

          interaction.reply({ embeds: [embed] });
      });
  }
});

/**
* Generates a text-based progress bar on one line.
* @param {number} percentage - The progress percentage (0-100).
* @returns {string} - A progress bar string.
*/
function createProgressBar(percentage) {
  const totalBars = 20; // Total number of bars in the progress bar.
  const filledBars = Math.floor((percentage / 100) * totalBars);
  const emptyBars = totalBars - filledBars;

  const bar = '🟩'.repeat(filledBars) + '⬜'.repeat(emptyBars);
  return bar;
}



client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const commandName = interaction.commandName; // Properly define commandName

  if (commandName === 'settings') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'view') {
          db.get(`SELECT * FROM guild_settings WHERE guild_id = ?`, [interaction.guild.id], (err, row) => {
              if (err || !row) {
                  const embed = new MessageEmbed()
                      .setTitle('Error 🚫')
                      .setDescription('No settings found.')
                      .setColor('#FF0000');
                  return interaction.reply({ embeds: [embed] });
              }

              const embed = new MessageEmbed()
                  .setTitle('Guild Settings ⚙️')
                  .setDescription(`**Base XP:** ${row.base_xp}\n**Cooldown:** ${row.cooldown} seconds`)
                  .setColor('#3498DB');
              interaction.reply({ embeds: [embed] });
          });
      }

      if (subcommand === 'update') {
          const baseXp = interaction.options.getInteger('base_xp');
          const cooldown = interaction.options.getInteger('cooldown');

          db.run(
              `INSERT INTO guild_settings (guild_id, base_xp, cooldown)
               VALUES (?, ?, ?)
               ON CONFLICT(guild_id) DO UPDATE SET base_xp = excluded.base_xp, cooldown = excluded.cooldown`,
              [interaction.guild.id, baseXp, cooldown],
              (err) => {
                  if (err) {
                      const embed = new MessageEmbed()
                          .setTitle('Error 🚫')
                          .setDescription('Failed to update settings.')
                          .setColor('#FF0000');
                      return interaction.reply({ embeds: [embed] });
                  }

                  const embed = new MessageEmbed()
                      .setTitle('Settings Updated ✅')
                      .setDescription(`**Base XP:** ${baseXp}\n**Cooldown:** ${cooldown} seconds`)
                      .setColor('#00FF00');
                  interaction.reply({ embeds: [embed] });
              }
          );
      }
  }

});


client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const commandName = interaction.commandName;

  if (commandName === 'setlevelrole') {
    if (!interaction.member.permissions.has('ADMINISTRATOR')) {
        const embed = new MessageEmbed()
            .setTitle('Insufficient Permissions 🚫')
            .setDescription('You need to be an administrator to use this command.')
            .setColor('#FF0000')
            .setFooter('Leveling System', interaction.guild.iconURL());
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const level = interaction.options.getInteger('level');
    const role = interaction.options.getRole('role');
    const guildId = interaction.guild.id;

    db.run(
        `INSERT INTO level_roles (level, guild_id, role_id) VALUES (?, ?, ?) 
         ON CONFLICT(level, guild_id, role_id) DO NOTHING`,
        [level, guildId, role.id],
        (err) => {
            if (err) {
                console.error(`Error setting role for level ${level} in guild ${guildId}:`, err);
                const embed = new MessageEmbed()
                    .setTitle('Error 🚫')
                    .setDescription('Failed to set the level role. Please try again later.')
                    .setColor('#FF0000')
                    .setFooter('Leveling System', interaction.guild.iconURL());
                return interaction.reply({ embeds: [embed] });
            }

            const embed = new MessageEmbed()
                .setTitle('Level Role Set ✅')
                .setDescription(`The role **${role.name}** will now be applied at level **${level}** in this guild.`)
                .setColor('#00FF00')
                .setFooter('Leveling System', interaction.guild.iconURL());
            interaction.reply({ embeds: [embed] });
        }
    );
}
});



client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const commandName = interaction.commandName;

  if (commandName === 'setxp') {
      if (!interaction.member.permissions.has('Administrator')) {
          const embed = new EmbedBuilder()
              .setTitle('Insufficient Permissions 🚫')
              .setDescription('You need to be an administrator to use this command.')
              .setColor('#FF0000')
              .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
          return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      const xp = interaction.options.getInteger('xp');
      const level = interaction.options.getInteger('level'); // Optional level input

      let xpToSet = xp;

      if (level !== null) {
          // If level is provided, calculate the corresponding XP based on the formula
          const guildId = interaction.guild.id;

          db.get(
              `SELECT base_xp FROM guild_settings WHERE guild_id = ?`,
              [guildId],
              (err, row) => {
                  if (err || !row) {
                      const embed = new EmbedBuilder()
                          .setTitle('Error 🚫')
                          .setDescription('Failed to fetch XP settings. Please ensure your guild settings are configured.')
                          .setColor('#FF0000')
                          .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
                      return interaction.reply({ embeds: [embed] });
                  }

                  const baseXp = row.base_xp || 100;
                  xpToSet = Math.pow(level, 2) * baseXp;

                  // Update the user's XP
                  setUserXp(user.id, xpToSet);
              }
          );
      } else {
          if (xp === null) {
              const embed = new EmbedBuilder()
                  .setTitle('Invalid Input 🚫')
                  .setDescription('You must provide either XP or a level to set.')
                  .setColor('#FF0000')
                  .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
              return interaction.reply({ embeds: [embed], ephemeral: true });
          }

          setUserXp(user.id, xpToSet);
      }

      function setUserXp(userId, xpAmount) {
          db.run(
              `INSERT INTO user_xp (user_id, xp) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp`,
              [userId, xpAmount],
              (err) => {
                  if (err) {
                      console.error(`Error setting XP for user ${userId}:`, err);
                      const embed = new EmbedBuilder()
                          .setTitle('Error 🚫')
                          .setDescription('Failed to set XP. Please try again later.')
                          .setColor('#FF0000')
                          .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
                      interaction.reply({ embeds: [embed] });
                      return;
                  }

                  const embed = new EmbedBuilder()
                      .setTitle('XP Set Successfully ✅')
                      .setDescription(`Set **${user.username}**'s XP to **${xpAmount.toFixed(2)}**.`)
                      .setColor('#00FF00')
                      .setFooter({ text: 'Leveling System', iconURL: interaction.guild.iconURL() });
                  interaction.reply({ embeds: [embed] });
              }
          );
      }
  }
});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Ignore messages from bots

  const userId = message.author.id;
  const guildId = message.guild.id;

  try {
      const canEarn = await canEarnXp(userId, guildId); // Check cooldown or other conditions
      if (!canEarn) {
          console.log(`User ${message.author.username} is on cooldown for earning XP.`);
          return;
      }

      const xpGain = Math.random() * (5.0 - 1.0) + 1.0; // Random XP between 1 and 5
      console.log(`User ${message.author.username} earned ${xpGain.toFixed(2)} XP.`);

      const totalXp = await updateUserXp(userId, guildId, xpGain); // Update XP in database
      updateLastXpTime(userId, guildId); // Update cooldown time

      console.log(`User ${message.author.username} now has ${totalXp.toFixed(2)} XP.`);

      const level = calculateLevel(totalXp); // Calculate user level based on total XP
      console.log(`User ${message.author.username} is now level ${level}.`);

      const member = message.guild.members.cache.get(userId);
      if (member) {
          await assignRoles(member, level, message.guild); // Assign roles if applicable
          console.log(`Roles updated for ${message.author.username} based on level ${level}.`);
      }
  } catch (err) {
      console.error(`Error processing message from ${message.author.username}:`, err);
  }
});



async function syncXpAcrossServers() {
  db.all(
      `SELECT user_id, xp FROM user_xp`,
      async (err, rows) => {
          if (err) {
              console.error(err);
              return;
          }

          for (const { user_id, xp } of rows) {
              const level = calculateLevel(xp);
              client.guilds.cache.forEach(async (guild) => {
                  try {
                      const member = await guild.members.fetch(user_id);
                      await assignRoles(member, level, guild);
                  } catch (error) {
                      console.error(`Error syncing XP for user ${user_id} in guild ${guild.id}:`, error);
                  }
              });
          }
      }
  );
}


// Move this definition above the `scheduleJob` call
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  try {
      scheduleJob('*/30 * * * *', syncXpAcrossServers);
      console.log('Scheduled XP sync across servers.');
  } catch (error) {
      console.error('Error during bot initialization:', error);
  }
});

client.login(TOKEN)
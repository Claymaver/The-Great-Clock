# **The Great Clock**  

The **Great Clock Bot** is a Discord bot designed for **XP leveling, role management, custom embeds, global moderation, automated forwarding, shop & economy system, gambling features, and interactive fun commands**.

---

## **Features**  

- XP **leveling system** with customizable **base XP and multipliers**.  
- **Automatic role rewards** based on level.  
- **Custom embed creation** and multi-server message sending.  
- **Global ban/kick system** across multiple servers.  
- **Message forwarding & auto-publishing** for announcements.  
- **Economy system** (Bolts currency, shop, inventory, gambling).  
- **Fun features** like **Death Battles, slot machines, roulette, and a random quote system**.  

---

## **📌 Commands**  

### **🆙 XP and Leveling**  

1. **`/tgc-profile [user]`** → View your or another user's XP, level, and progress.  
2. **`/tgc-setxp <user> [xp] [level]`** → Manually set a user’s XP or level.  
3. **`/tgc-setbasexp <value>`** → Set the base XP required for leveling up.  
4. **`/tgc-setmultiplier <value>`** → Adjust XP scaling multiplier.  
5. **`/tgc-setlevelrole <level> <role>`** → Assign a role when users reach a level.  
~~6. **`/tgc-importuserdata`** → Import user XP data from JSON.~~

---

### **🛠️ Moderation & Admin Commands**  

7. **`/tgc-ban <user> [duration] [reason]`** → Globally ban a user.  
8. **`/tgc-kick <user> [reason]`** → Kick a user from all servers.  
9. **`/tgc-timeout <user> <duration> [reason]`** → Timeout a user across all servers.  
10. **`/tgc-banlist`** → View the global ban list.  
11. **`/tgc-unban <user>`** → Unban a user.  
12. **`/tgc-lock <channel>`** → Lock or unlock a channel.  
13. **`/tgc-openticket`** → Open a support or report ticket.  
14. **`/tgc-closeticket`** → Close an active support ticket.  
15. **`/tgc-setlogchannel <channel>`** → Set the log channel for moderation actions.  
16. **`/tgc-managecommandroles`** → Manage roles that can use restricted commands.  

---

### **📩 Embed & Message Forwarding**  

17. **`/tgc-createembed`** → Create and send an embed message.  
18. **`/tgc-sendmessage`** → Send a normal text message using a modal.  
19. **`/tgc-forward <source_id> <target_id> [color]`** → Forward messages from one channel to another.  
20. **`/tgc-removeforward <source_id>`** → Remove message forwarding from a channel.  
21. **`/tgc-toggleautopublish <channel>`** → Enable/disable auto-publishing in announcement channels.  

---

### **💰 Economy & Shop System**  

22. **`/tgc-balance`** → Check your current **bolts** balance.  
23. **`/tgc-givecurrency <user> <amount>`** → Give **bolts** to a user. *(Admin only)*  
24. **`/tgc-shop`** → Open the shop and browse items.  
~~25. **`/tgc-buy <item>`** → Buy an item from the shop.~~
26. **`/tgc-inventory`** → View your inventory of purchased items.  
27. **`/tgc-additem <name> <price> <category> <description>`** → Add an item to the shop. *(Admin only)*  
28. **`/tgc-removeitem <item>`** → Remove an item from the shop. *(Admin only)*  

---

### **🎰 Gambling & Jackpot**  

29. **`/tgc-slots <amount>`** → Play **slot machines** and win bolts!  
30. **`/tgc-roulette <amount>`** → Bet on **roulette** and test your luck!  

🎲 **Jackpot System:** A portion of lost bets goes into a **jackpot pool**. One lucky player **randomly wins the entire jackpot**!  

---

### **⚔️ Fun Commands**  

31. **`/tgc-deathbattle <fighter1> <fighter2>`** → **Start a real-time death battle** between two users!  
    - The winner **earns bolts** as a reward.  
    - Includes **animated battle updates**!  

32. **`/tgc-8ball <question>`** → Ask the magic **8-ball** a yes/no question.  
33. **`/tgc-randomquote`** → Get a **random Ratchet & Clank-themed quote**.  
34. **`/tgc-addquote <text>`** → Add a new **quote** to the database. *(Admin only)*  
35. **`/tgc-listquotes`** → List all stored **quotes** with IDs.  
36. **`/tgc-deletequote <id>`** → Delete a **quote** from the database. *(Admin only)*  

---

## **📜 Predefined Embed Colors**  
| Name            | Hex Code  |  
|----------------|----------|  
| **Pink**        | `#eb0062` |  
| **Red**         | `#ff0000` |  
| **Dark Red**    | `#7c1e1e` |  
| **Orange**      | `#ff4800` |  
| **Yellow**      | `#ffe500` |  
| **Green**       | `#1aff00` |  
| **Forest Green**| `#147839` |  
| **Light Blue**  | `#00bdff` |  
| **Dark Blue**   | `#356feb` |  

- Use these when selecting a color in the **`/tgc-forward`** command:  
  ```
  /tgc-forward source_id:123 target_id:456 color:"Dark Blue"
  ```

---

## **🎮 Public Commands**  

✅ `/tgc-profile`  
✅ `/tgc-openticket`  
✅ `/tgc-shop`  
✅ `/tgc-buy`  
✅ `/tgc-inventory`  
✅ `/tgc-balance`  
✅ `/tgc-slots`  
✅ `/tgc-roulette`  
✅ `/tgc-checkjackpot`  
✅ `/tgc-deathbattle`  
✅ `/tgc-8ball`  
✅ `/tgc-randomquote`  

*All other commands require **permissions set via `/tgc-managecommandroles`**.*  

---

## **📥 Installation**  

### **Prerequisites**  
- **Node.js v16 or higher**  
- **Discord bot token**  
- **SQLite installed**  

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
4. **Run the bot:**  
   ```bash
   node index.js
   ```

---

## **⚙️ Customization**  

- Adjust **XP leveling rates** in the `guild_settings` table.  
- Modify the **jackpot payout system** in `jackpot_pool`.  
- Add or remove **shop items** via `/tgc-additem` and `/tgc-removeitem`.  

---

## **💡 Contributing**  
Feel free to submit **issues or pull requests**. Contributions are welcome!  

---

## **📜 License**  
This project is licensed under the **MIT License**.  

---

🚀 **Enjoy using The Great Clock!** Need help? Contact me via **GitHub Issues or Discord**!  

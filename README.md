# Ultimate Shoutbox Beautifier for TheLounge

**Known compatibility:** ATH, BHD, HUNO, LST, ULCX

## Screenshots

[![Screenshot 1](https://i.badkitty.zone/4YV6xk.png)](https://i.badkitty.zone/4YV6xk.png)
[![Screenshot 2](https://i.badkitty.zone/T3mnBU.png)](https://i.badkitty.zone/T3mnBU.png)

This is a reworked version of [fulcrum's original script](https://paste.passtheheadphones.me/?ce929e1387e5bbdf#2bXLMKYHNXZu4tSdE2YkGnQvpwVA43LM3TCu7jxqEhD3) that adds:

- **Handler architecture:** Makes it easier to add new formats
- **Custom decorators:** Set a prefix/suffix for bridged usernames
- **DOM metadata:** Completely customize appearance with TheLounge theme CSS
- **Regex matcher support:** Pair with custom handlers to do almost anything
- **Preview support:** Surgical DOM modification preserves link previews and event listeners
- **More handlers:** BHD, extensive HUNO support
- **Nick coloring:** Bridged usernames get proper TheLounge colors instead of inheriting bot colors

## Credits

- **fulcrum:** Original script ([https://aither.cc/forums/topics/3874](https://aither.cc/forums/topics/3874))
- **marks:** Autocomplete enablement ([https://aither.cc/forums/topics/3874/posts/32274](https://aither.cc/forums/topics/3874/posts/32274))

## Installation

- Install Tampermonkey or a compatible userscript manager
- Create a new script and paste this in
- Set `@match` to the IP or domain you access TheLounge on

## Troubleshooting

- Make sure `@match` is set to your TheLounge domain, in the same format as: `*://your-thelounge-domain.com/*`
- Try disabling autocomplete (`USE_AUTOCOMPLETE: false`)
- Check the browser console for errors
- When in doubt, simply refresh the page (sometimes necessary regardless)

## Changelog

- **1.0** - Initial release
- **2.0** - Fix link previews, change return structure to add `modifyContent` and `prefixToRemove`
- **2.1** - Sanitize zero-width characters (fixes HUNO Discord handler)
- **2.2** - Add option to hide join/quit messages, add TheLounge icon to Tampermonkey
- **2.3** - Add color matching - bridged usernames get proper TheLounge colors

## CSS Styling

Custom CSS can be added easily in **TheLounge** > **Settings** > **Appearance**.

You can use the following CSS selectors to target bridged messages in your themes:

```css
span[data-bridged] /* selects the usernames of all bridged messages */
span[data-bridged-channel] /* selects bridged messages from specific channels */
attr(data-bridged) /* retrieves the embedded metadata prefix (e.g., 'SB') */
```

### Examples

Italicize all bridged usernames:

```css
span[data-bridged] { 
  font-style: italic; 
}
```

Show HUNO Discord ranks in tiny text before username, only in `#huno*` channels:

```css
span[data-bridged-channel~="#huno"]:before {
  content: attr(data-bridged);
  font-size: 8px;
  margin-right: 5px;

# Donations

Like what I do? Feel free to [buy me a coffee](https://buymeacoffee.com/spindrift). :)
}
```

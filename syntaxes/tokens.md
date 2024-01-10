# Tokens

[Players](#players)  
[Objects](#objects)  
[Creatures](#creatures)  
[Events](#events)  
[General](#general)  

## Players

Token | Description
---  | ---  
`$P#`  | Inserts the player's name.
`$P#A` | Inserts "Master" or "Mistress" based on gender.
`$P#B` | Inserts the player's first and last name.
`$P#F` | Inserts "himself" or "herself" based on gender.
`$P#G` | Inserts "he" or "she" based on gender.
`$P#H` | Inserts "his" or "her" based on gender.
`$P#I` | Inserts "him" or "her" based on gender.
`$P#L` | Inserts the player's last name.
`$P#M` | Inserts "man" or "woman" based on gender.
`$P#P` | Inserts the player's profession.
`$P#R` | Inserts the player's race.
`$P#S` | Inserts "sir" or "madam" based on gender.
`$P#U` | Same as `$P#` (provided for use with `$X`).
`$P#`  | Inserts the field you indicate after the `:` such as `$P#:plevel`.
`$X#`  | Works like `$C#D` if not NULL, otherwise as `$P#`.
`$X#F` | Inserts "himself" or "herself" based on gender of creature. If not NULL, otherwise as `$P#F`.
`$X#G` | Inserts "he" or "she" based on gender of creature. If not NULL, otherwise as `$P#G`.
`$X#H` | Inserts "his" or "her" based on gender of creature. If not NULL, otherwise as `$P#H`.
`$X#I` | Inserts "him" or "her" based on gender of creature. If not NULL, otherwise as `$P#I`.

## Objects

Token | Description
---  | ---  
`$O#A` | Inserts the article of the existence.
`$O#J` | Inserts the adjective of the existence.
`$O#N` | Inserts the noun of the existence.
`$O#D` | Inserts the article, adjective and noun of the existence.
`$O#S` | Same as `$O#D` but will not include the article.
`$O#C` | Inserts "opened" or "closed" depending on the closed flag of object.
`$O#O` | Same as `$O#C` but inserts: "an opened" or "a closed" instead.
`$O#T` | Inserts "the" followed by the noun of the existence.
`$O#M` | Inserts `:pronoun` field if it is set, otherwise as `$O#N`.
`$O#`  | Inserts the field you indicate after the `:` such as `$O#:text_language`.

## Creatures

Token | Description
---  | ---  
`$C#A` | Inserts the article of the creature.
`$C#J` | Inserts the adjective of the creature.
`$C#N` | Inserts the noun of the creature.
`$C#D` | Inserts the article, adjective and noun of the creature.
`$C#S` | Same as `$C#D` but will not include the article.
`$C#T` | Inserts `:crtr_name` field if it is set, otherwise inserts "the" followed by the noun of the creature.
`$C#U` | Inserts "The", adjective and noun of the creature.
`$C#M` | Inserts `:pronoun` field if it is set, otherwise as `$C#N`.
`$C#`  | Inserts the field you indicate after the `:` such as `$C#:NumLegs`.
`$X#`  | Works like `$C#D` if not NULL, otherwise as `$P#`
`$X#F` | Inserts "himself" or "herself" based on gender of creature. If not NULL, otherwise as `$P#F`.
`$X#G` | Inserts "he" or "she" based on gender of creature. If not NULL, otherwise as `$P#G`.
`$X#H` | Inserts "his" or "her" based on gender of creature. If not NULL, otherwise as `$P#H`.
`$X#I` | Inserts "him" or "her" based on gender of creature. If not NULL, otherwise as `$P#I`.

## Events

Token | Description
---  | ---  
`$E#A` | Inserts the article of the event.
`$E#J` | Inserts the adjective of the event.
`$E#N` | Inserts the noun of the event.
`$E#D` | Inserts the article, adjective and noun of the event.
`$E#S` | Same as `$E#D` but will not include the article.
`$E#T` | Inserts "the" followed by the noun of the event.
`$E#M` | Inserts `:pronoun` field if it is set, otherwise as `$E#N`.
`$E#`  | Inserts the field you indicate after the `:` such as `$E#:data1`.

## General

Token | Description
---  | ---  
`$$`   | Causes a single `$` to be inserted.
`$\`   | Supresses the automatic linefeed.
`$^`   | Causes the first letter of the string to be made uppercase.
`$A#`  | Inserts the ASCII representation of the value variable `A#`.
`$B#`  | Inserts the ASCII representation of the value variable `B#`.
`$D#`  | Returns the value of `($Vx/100)` with the remainder as a decimal.
`$V#`  | Inserts the ASCII representation of the value variable `V#`.
`$L#`  | Same as `$V#` but right aligned in a field of 7 characters.
`$S#`  | Inserts the contents of string variable `S#`.
`$K#`  | Same as `$S#` but right aligned in field of 16 characters.
`$T#`  | Inserts the contents of string variable `T#`.
`$Q`   | Inserts a double quote: ".
`$R`   | Inserts a linefeed.
`$*`   | Inserts an ESC code (ASCII 27).
`$+`   | Capitalizes the first letter of the next string token.
`$'`   | Adds 's to the next string token, properly wrapped with XML.
`$:table:#`  |  Insert table element such as `$:table#[0,0,0]`.
`$ZE`  | Inserts time with variable that follows. Examples: `$ZE$TIME`  `$ZEA0`  `$ZEE1:data1`  `$ZEP0:startthischar`. (Note: System variables like `$TIME` require the `$`).
`$r#`  | Inserts the room number (lowercase r).
`$r#`  | Inserts the room field you indicate after the `:` such as `$r#:rmname` (lowercase r).
`$:$`  | Insert a system variable into a string such as `$:$LASTMATCH` or `$:$GAMENAME`.

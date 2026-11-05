import { BookStore } from "../src/store.js";

const store = new BookStore("/home/zdxadmin/zdx-book-studio/data/books.sqlite");
const book = store.list().find(item => item.title === "CodeBound");
if (!book) throw new Error("CodeBound not found");

const naming = [
  { id: "phreaker", formal: "Resonants", common: "Phreakers" },
  { id: "hacker", formal: "Formwrights", common: "Hackers" },
  { id: "crypto", formal: "Sealkeepers", common: "Crypto" }
];
for (const name of naming) {
  const character = book.characters.find(item => item.id === name.id);
  if (!character) throw new Error(`Character missing: ${name.id}`);
  character.guild = name.formal;
  const note = `Formally belongs to the ${name.formal}; “${name.common}” is the common historical name used in everyday speech.`;
  if (!character.publicProfile.includes(note)) character.publicProfile = `${note} ${character.publicProfile}`;
}
const convention = "Formal guild names are Resonants (Carrier), Formwrights (Form), and Sealkeepers (Warrant). Phreakers, Hackers, and Crypto are their common historical names and remain natural in dialogue and narration.";
if (!book.canon.includes(convention)) book.canon = `${book.canon} ${convention}`;
store.save(book);
console.log(JSON.stringify({ guilds: book.characters.slice(0, 3).map(c => c.guild), canonUpdated: true }));

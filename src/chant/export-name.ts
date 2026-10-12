/**
 * The name an Op is exported under in the files yodel writes or prints
 * (#2): its own, in camel case, so every Op in a project has an export of
 * its own. chant discovers an Op under any export name, but a chant
 * workspace folds the whole member directory to read its tables as
 * outputs, and two files that both export `op` stop that fold, which
 * leaves every link to the member unresolved.
 */
export function opExportName(opName: string): string {
  const words = opName.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  const camel = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  if (camel === "") return "op";
  return /^[0-9]/.test(camel) ? `op${camel.charAt(0).toUpperCase()}${camel.slice(1)}` : camel;
}

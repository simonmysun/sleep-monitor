import fs from "fs";
import path from "path";
import vm from "vm";

interface RenderOptions {
  timeout?: number;
}

export class Template {
  filePath: string;
  template: string;
  script: vm.Script;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.template = fs.readFileSync(this.filePath, "utf8");
    const wrappedCode = "`" + this.template + "`";
    this.script = new vm.Script(wrappedCode, { filename: this.filePath });
  }

  render(data: any = {}, options: RenderOptions = {}) {
    const { timeout = 1000 } = options;
    const sandbox = Object.create(null);
    Object.assign(sandbox, data);
    const context = vm.createContext(sandbox);
    return this.script.runInContext(context, { timeout });
  }
}

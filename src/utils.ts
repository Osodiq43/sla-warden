export function extractJsonFromStdout(stdout: string): any {
  try {
    // Locate the first opening brace and last closing brace to isolate the JSON envelope
    const startObj = stdout.indexOf("{");
    const endObj = stdout.lastIndexOf("}");
    
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      const jsonString = stdout.substring(startObj, endObj + 1);
      return JSON.parse(jsonString);
    }
    
    return null;
  } catch {
    return null;
  }
}

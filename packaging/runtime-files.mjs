// Build-time selection only. Development helpers remain in the source tree.
import ts from 'typescript';
import path from 'node:path';
export function runtimeFiles(files,entry='server.js'){
 const selected=new Set();
 function visit(name){
  if(selected.has(name))return;
  if(!files.has(name))throw Error('Missing runtime module: '+name);
  selected.add(name);
  const tree=ts.createSourceFile(name,files.get(name),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  function dependency(specifier){
   if(!specifier.startsWith('.'))return;
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),specifier));
   if(target.startsWith('../')||path.posix.isAbsolute(target)||!target.endsWith('.js'))throw Error('Unsafe runtime dependency: '+target);
   visit(target);
  }
  function walk(node){
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))dependency(node.moduleSpecifier.text);
   if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){
    if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw Error('Nonliteral runtime import in '+name);
    dependency(node.arguments[0].text);
   }
   ts.forEachChild(node,walk);
  }
  walk(tree);
 }
 visit(entry);return selected;
}

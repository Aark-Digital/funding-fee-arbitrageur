import AVLTree from 'avl';

export function emptyAVLTree(
  ascending: boolean = true
): AVLTree<number, number> {
  return new AVLTree(
    (a: number, b: number) => (ascending ? a - b : b - a),
    true
  );
}

export function updateAVLTree(
  avl: AVLTree<number, number>,
  quotes: [number, number][]
) {
  for (const quote of quotes) {
    const [p, q] = [quote[0], quote[1]];
    if (q === 0) {
      avl.remove(p);
    } else if (avl.contains(p)) {
      const node = avl.find(p)!;
      node.data = q;
    } else {
      avl.insert(p, q);
    }
  }
}

export function avlTreeToArray(
  avl: AVLTree<number, number>
): [number, number][] {
  const ps = avl.keys();
  const qs = avl.values();
  return ps.map((p: number, i: number) => [p, qs[i]]);
}

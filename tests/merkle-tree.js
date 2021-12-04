const { keccak256 } = require('ethereumjs-util');
const anchor = require('@project-serum/anchor');

function getMerkleProof(data) {
  let totalTokens = 0;
  let gIndex = 0;
  const elements = data.map((x) => {
    const index = new anchor.BN(gIndex++);
    const address = x.address;
    const amount = new anchor.BN(x.amount);
    const leaf = MerkleTree.toLeaf(index, address, amount);
    totalTokens += amount * 1;
    return {
      leaf,
      index: index,
      address: address,
      amount
    };
  });

  const merkleTree = new MerkleTree(elements.map(x => x.leaf));
  const root = merkleTree.getRoot();

  let proofs = elements.map((x) => {
    return {
      proofs: merkleTree.getProof(x.leaf),
      index: x.index,
      address: x.address,
      amount: x.amount
    };
  });

  const merkleData = {
    root: root,
    totalTokens: totalTokens,
    proofs,
  };

  return merkleData;
}

class MerkleTree {
  constructor(elements) {
    // Filter empty strings
    this.elements = elements.filter(el => el);

    // Sort elements
    this.elements.sort(Buffer.compare);
    // Deduplicate elements
    this.elements = this.bufDedup(this.elements);

    // Create layers
    this.layers = this.getLayers(this.elements);
  }

  getLayers(elements) {
    if (elements.length === 0) {
      return [['']];
    }

    const layers = [];
    layers.push(elements);

    // Get next layer until we reach the root
    while (layers[layers.length - 1].length > 1) {
      layers.push(this.getNextLayer(layers[layers.length - 1]));
    }

    return layers;
  }

  getNextLayer(elements) {
    return elements.reduce((layer, el, idx, arr) => {
      if (idx % 2 === 0) {
        // Hash the current element with its pair element
        layer.push(MerkleTree.combinedHash(el, arr[idx + 1]));
      }

      return layer;
    }, []);
  }

  static verifyProof(index, account, amount, proof, root) {
    let computedHash = MerkleTree.toLeaf(index, account, amount);
    for (const item of proof) {
      computedHash = MerkleTree.combinedHash(computedHash, item);
      console.log(computedHash);
    }

    return computedHash.equals(root);
  }

  static toLeaf(index, account, amount) {
    const buf = Buffer.concat([
      Buffer.from(index.toArray('be', 8)),
      account.toBuffer(),
      Buffer.from(amount.toArray('be', 8)),
    ]);
    return keccak256(buf);
  }

  static combinedHash(first, second) {
    if (!first) { return second; }
    if (!second) { return first; }

    return keccak256(MerkleTree.sortAndConcat(first, second));
  }

  getRoot() {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(el) {
    let idx = this.bufIndexOf(el, this.elements);

    if (idx === -1) {
      throw new Error('Element does not exist in Merkle tree');
    }

    return this.layers.reduce((proof, layer) => {
      const pairElement = this.getPairElement(idx, layer);

      if (pairElement) {
        proof.push(pairElement);
      }

      idx = Math.floor(idx / 2);

      return proof;
    }, []);
  }

  getPairElement(idx, layer) {
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    if (pairIdx < layer.length) {
      return layer[pairIdx];
    } else {
      return null;
    }
  }

  bufIndexOf(el, arr) {
    let hash;

    // Convert element to 32 byte hash if it is not one already
    if (el.length !== 32 || !Buffer.isBuffer(el)) {
      hash = keccak256(el);
    } else {
      hash = el;
    }

    for (let i = 0; i < arr.length; i++) {
      if (hash.equals(arr[i])) {
        return i;
      }
    }

    return -1;
  }

  bufDedup(elements) {
    return elements.filter((el, idx) => {
      return idx === 0 || !elements[idx - 1].equals(el);
    });
  }

  static sortAndConcat(...args) {
    return Buffer.concat([...args].sort(Buffer.compare));
  }
}

module.exports = {
  MerkleTree,
  getMerkleProof,
};

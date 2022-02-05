export type ClaimingFactory = {
  "version": "0.1.0",
  "name": "claiming_factory",
  "instructions": [
    {
      "name": "initializeConfig",
      "accounts": [
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "bump",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initBitmap",
      "accounts": [
        {
          "name": "payer",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "bitmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "distributor",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "bump",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initialize",
      "accounts": [
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "adminOrOwner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "vaultAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": "InitializeArgs"
          }
        }
      ]
    },
    {
      "name": "updateRoot",
      "accounts": [
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "adminOrOwner",
          "isMut": false,
          "isSigner": true
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": "UpdateRootArgs"
          }
        }
      ]
    },
    {
      "name": "setPaused",
      "accounts": [
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "adminOrOwner",
          "isMut": false,
          "isSigner": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "addAdmin",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "admin",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "removeAdmin",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "admin",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "withdrawTokens",
      "accounts": [
        {
          "name": "distributor",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "vaultAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "targetWallet",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claim",
      "accounts": [
        {
          "name": "distributor",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "claimer",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "bitmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "targetWallet",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": "ClaimArgs"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "publicKey"
          },
          {
            "name": "admins",
            "type": {
              "array": [
                {
                  "option": "publicKey"
                },
                10
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "bitMap",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "data",
            "type": {
              "array": [
                "u64",
                64
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "merkleDistributor",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merkleIndex",
            "type": "u64"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "vault",
            "type": "publicKey"
          }
        ]
      }
    }
  ],
  "types": [
    {
      "name": "InitializeArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "UpdateRootArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "unpause",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "ClaimArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "merkleProof",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    }
  ],
  "events": [
    {
      "name": "Claimed",
      "fields": [
        {
          "name": "merkleIndex",
          "type": "u64",
          "index": false
        },
        {
          "name": "index",
          "type": "u64",
          "index": false
        },
        {
          "name": "account",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "amount",
          "type": "u64",
          "index": false
        }
      ]
    },
    {
      "name": "MerkleRootUpdated",
      "fields": [
        {
          "name": "merkleIndex",
          "type": "u64",
          "index": false
        },
        {
          "name": "merkleRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          },
          "index": false
        }
      ]
    },
    {
      "name": "TokensWithdrawn",
      "fields": [
        {
          "name": "token",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "amount",
          "type": "u64",
          "index": false
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "MaxAdmins"
    },
    {
      "code": 6001,
      "name": "AdminNotFound"
    },
    {
      "code": 6002,
      "name": "InvalidAmountTransferred"
    },
    {
      "code": 6003,
      "name": "InvalidProof"
    },
    {
      "code": 6004,
      "name": "AlreadyClaimed"
    },
    {
      "code": 6005,
      "name": "NotOwner"
    },
    {
      "code": 6006,
      "name": "NotAdminOrOwner"
    },
    {
      "code": 6007,
      "name": "ChangingPauseValueToTheSame"
    },
    {
      "code": 6008,
      "name": "Paused"
    }
  ]
};

export const IDL: ClaimingFactory = {
  "version": "0.1.0",
  "name": "claiming_factory",
  "instructions": [
    {
      "name": "initializeConfig",
      "accounts": [
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "bump",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initBitmap",
      "accounts": [
        {
          "name": "payer",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "bitmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "distributor",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "bump",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initialize",
      "accounts": [
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "adminOrOwner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "vaultAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": "InitializeArgs"
          }
        }
      ]
    },
    {
      "name": "updateRoot",
      "accounts": [
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "adminOrOwner",
          "isMut": false,
          "isSigner": true
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": "UpdateRootArgs"
          }
        }
      ]
    },
    {
      "name": "setPaused",
      "accounts": [
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "adminOrOwner",
          "isMut": false,
          "isSigner": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "addAdmin",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "admin",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "removeAdmin",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "admin",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "withdrawTokens",
      "accounts": [
        {
          "name": "distributor",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "config",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "vaultAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "targetWallet",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claim",
      "accounts": [
        {
          "name": "distributor",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "claimer",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "bitmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "targetWallet",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": "ClaimArgs"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "publicKey"
          },
          {
            "name": "admins",
            "type": {
              "array": [
                {
                  "option": "publicKey"
                },
                10
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "bitMap",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "data",
            "type": {
              "array": [
                "u64",
                64
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "merkleDistributor",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merkleIndex",
            "type": "u64"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "vault",
            "type": "publicKey"
          }
        ]
      }
    }
  ],
  "types": [
    {
      "name": "InitializeArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "UpdateRootArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "unpause",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "ClaimArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "merkleProof",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    }
  ],
  "events": [
    {
      "name": "Claimed",
      "fields": [
        {
          "name": "merkleIndex",
          "type": "u64",
          "index": false
        },
        {
          "name": "index",
          "type": "u64",
          "index": false
        },
        {
          "name": "account",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "amount",
          "type": "u64",
          "index": false
        }
      ]
    },
    {
      "name": "MerkleRootUpdated",
      "fields": [
        {
          "name": "merkleIndex",
          "type": "u64",
          "index": false
        },
        {
          "name": "merkleRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          },
          "index": false
        }
      ]
    },
    {
      "name": "TokensWithdrawn",
      "fields": [
        {
          "name": "token",
          "type": "publicKey",
          "index": false
        },
        {
          "name": "amount",
          "type": "u64",
          "index": false
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "MaxAdmins"
    },
    {
      "code": 6001,
      "name": "AdminNotFound"
    },
    {
      "code": 6002,
      "name": "InvalidAmountTransferred"
    },
    {
      "code": 6003,
      "name": "InvalidProof"
    },
    {
      "code": 6004,
      "name": "AlreadyClaimed"
    },
    {
      "code": 6005,
      "name": "NotOwner"
    },
    {
      "code": 6006,
      "name": "NotAdminOrOwner"
    },
    {
      "code": 6007,
      "name": "ChangingPauseValueToTheSame"
    },
    {
      "code": 6008,
      "name": "Paused"
    }
  ]
};

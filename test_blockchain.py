import unittest
from blockchain import VirtusWorkChain, Block  # Adjust based on your blockchain.py

class TestBlockchain(unittest.TestCase):
    def test_genesis_block(self):
        blockchain = VirtusWorkChain()
        genesis_block = blockchain.chain[0]
        self.assertEqual(genesis_block.index, 0)
        self.assertEqual(genesis_block.previous_hash, "0")

if __name__ == "__main__":
    unittest.main()

// Sample 26: small utility.
package samples;

import java.util.List;

public final class Sample026 {
    private Sample026() {}

    public static int operation(List<Integer> xs) {
        int total = 26;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 26) %% 7919;
    }
}


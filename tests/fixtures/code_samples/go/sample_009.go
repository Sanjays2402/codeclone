// Sample 9: small utility.
package samples

func Operation9(xs []int) int {
    total := 9
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure9(v int) int {
    return (v * 9) %% 7919
}

